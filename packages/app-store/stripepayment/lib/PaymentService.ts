import type { Booking, Payment, Prisma } from "@prisma/client";
import Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import z from "zod";

import { sendAwaitingPaymentEmail } from "@calcom/emails";
import type { IAbstractPaymentService } from "@calcom/lib/PaymentService";
import { getErrorFromUnknown } from "@calcom/lib/errors";
import prisma from "@calcom/prisma";
import type { CalendarEvent } from "@calcom/types/Calendar";

import { paymentOptionEnum } from "../zod";
import { createPaymentLink } from "./client";
import { retrieveOrCreateStripeCustomerByEmail } from "./customer";

const stripeCredentialKeysSchema = z.object({
  stripe_user_id: z.string(),
  default_currency: z.string(),
  stripe_publishable_key: z.string(),
});

const stripeAppKeysSchema = z.object({
  client_id: z.string(),
  payment_fee_fixed: z.number(),
  payment_fee_percentage: z.number(),
});

export class PaymentService implements IAbstractPaymentService {
  private stripe: Stripe;
  private credentials: z.infer<typeof stripeCredentialKeysSchema>;

  constructor(credentials: { key: Prisma.JsonValue }) {
    // parse credentials key
    this.credentials = stripeCredentialKeysSchema.parse(credentials.key);
    this.stripe = new Stripe(process.env.STRIPE_PRIVATE_KEY || "", {
      apiVersion: "2020-08-27",
    });
  }

  async create(
    payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    bookingId: Booking["id"],
    bookerEmail: string,
    paymentOption: string
  ) {
    try {
      const parsePaymentOption = paymentOptionEnum.safeParse(paymentOption);

      if (parsePaymentOption.success) {
        paymentOption = parsePaymentOption.data;
      } else {
        new Error(`Invalid payment option: ${paymentOption}`);
      }

      // Load stripe keys
      const stripeAppKeys = await prisma?.app.findFirst({
        select: {
          keys: true,
        },
        where: {
          slug: "stripe",
        },
      });

      // Parse keys with zod
      const { client_id, payment_fee_fixed, payment_fee_percentage } = stripeAppKeysSchema.parse(
        stripeAppKeys?.keys
      );
      const paymentFee = Math.round(payment.amount * payment_fee_percentage + payment_fee_fixed);

      const customer = await retrieveOrCreateStripeCustomerByEmail(
        bookerEmail,
        this.credentials.stripe_user_id
      );

      // If we want to charge the customer for a no show fee then create a setup intent
      if (paymentOption === "HOLD") {
        const params = {
          customer: customer.id,
          payment_method_types: ["card"],
          metadata: {
            bookingId,
          },
        };

        const setupIntent = await this.stripe.setupIntents.create(params, {
          stripeAccount: this.credentials.stripe_user_id,
        });

        const paymentData = await prisma?.payment.create({
          data: {
            uid: uuidv4(),
            app: {
              connect: {
                slug: "stripe",
              },
            },
            booking: {
              connect: {
                id: bookingId,
              },
            },
            amount: payment.amount,
            currency: payment.currency,
            externalId: setupIntent.id,

            data: Object.assign(
              {},
              {
                setupIntent,
                stripe_publishable_key: this.credentials.stripe_publishable_key,
                stripeAccount: this.credentials.stripe_user_id,
              }
            ) as unknown as Prisma.InputJsonValue,
            fee: paymentFee,
            refunded: false,
            success: false,
            paymentOption: paymentOption || "ON_BOOKING",
          },
        });

        return paymentData;
      }

      const params: Stripe.PaymentIntentCreateParams = {
        amount: payment.amount,
        currency: this.credentials.default_currency,
        payment_method_types: ["card"],
        application_fee_amount: paymentFee,
        customer: customer.id,
      };

      const paymentIntent = await this.stripe.paymentIntents.create(params, {
        stripeAccount: this.credentials.stripe_user_id,
      });

      const paymentData = await prisma?.payment.create({
        data: {
          uid: uuidv4(),
          app: {
            connect: {
              slug: "stripe",
            },
          },
          booking: {
            connect: {
              id: bookingId,
            },
          },
          amount: payment.amount,
          currency: payment.currency,
          externalId: paymentIntent.id,

          data: Object.assign({}, paymentIntent, {
            stripe_publishable_key: this.credentials.stripe_publishable_key,
            stripeAccount: this.credentials.stripe_user_id,
          }) as unknown as Prisma.InputJsonValue,
          fee: paymentFee,
          refunded: false,
          success: false,
          paymentOption: paymentOption || "ON_BOOKING",
        },
      });
      if (!paymentData) {
        throw new Error();
      }
      return paymentData;
    } catch (error) {
      console.error(error);
      throw new Error("Payment could not be created");
    }
  }

  async chargeCard(payment: Payment, bookingId: Booking["id"]): Promise<Payment> {
    try {
      const stripeAppKeys = await prisma?.app.findFirst({
        select: {
          keys: true,
        },
        where: {
          slug: "stripe",
        },
      });

      const setupIntent = payment.data?.setupIntent;

      // Parse keys with zod
      const { client_id, payment_fee_fixed, payment_fee_percentage } = stripeAppKeysSchema.parse(
        stripeAppKeys?.keys
      );

      const paymentFee = Math.round(payment.amount * payment_fee_percentage + payment_fee_fixed);

      const params = {
        amount: payment.amount,
        currency: payment.currency,
        application_fee_amount: paymentFee,
        customer: setupIntent.customer,
        payment_method: setupIntent.payment_method,
        off_session: true,
        confirm: true,
      };

      const paymentIntent = await this.stripe.paymentIntents.create(params, {
        stripeAccount: this.credentials.stripe_user_id,
      });

      console.log(typeof payment.data);

      const paymentData = await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          success: true,
          data: {
            ...payment.data,
            paymentIntent,
          },
        },
      });

      if (!paymentData) {
        throw new Error();
      }

      return paymentData;
    } catch (error) {
      console.error(error);
      throw new Error("Payment could not be created");
    }
  }

  async update(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  async refund(paymentId: Payment["id"]): Promise<Payment> {
    try {
      const payment = await prisma.payment.findFirst({
        where: {
          id: paymentId,
          success: true,
          refunded: false,
        },
      });
      if (!payment) {
        throw new Error("Payment not found");
      }

      const refund = await this.stripe.refunds.create(
        {
          payment_intent: payment.externalId,
        },
        { stripeAccount: (payment.data as unknown as StripePaymentData)["stripeAccount"] }
      );

      if (!refund || refund.status === "failed") {
        throw new Error("Refund failed");
      }

      const updatedPayment = await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          refunded: true,
        },
      });
      return updatedPayment;
    } catch (e) {
      const err = getErrorFromUnknown(e);
      throw err;
    }
  }

  async afterPayment(
    event: CalendarEvent,
    booking: {
      user: { email: string | null; name: string | null; timeZone: string } | null;
      id: number;
      startTime: { toISOString: () => string };
      uid: string;
    },
    paymentData: Payment
  ): Promise<void> {
    await sendAwaitingPaymentEmail({
      ...event,
      paymentInfo: {
        link: createPaymentLink({
          paymentUid: paymentData.uid,
          name: booking.user?.name,
          email: booking.user?.email,
          date: booking.startTime.toISOString(),
        }),
        paymentOption: paymentData.paymentOption || "ON_BOOKING",
        amount: paymentData.amount,
        currency: paymentData.currency,
      },
    });
  }

  async deletePayment(paymentId: Payment["id"]): Promise<boolean> {
    try {
      const payment = await prisma.payment.findFirst({
        where: {
          id: paymentId,
        },
      });

      if (!payment) {
        throw new Error("Payment not found");
      }
      const stripeAccount = (payment.data as unknown as StripePaymentData).stripeAccount;

      if (!stripeAccount) {
        throw new Error("Stripe account not found");
      }
      // Expire all current sessions
      const sessions = await this.stripe.checkout.sessions.list(
        {
          payment_intent: payment.externalId,
        },
        { stripeAccount }
      );
      for (const session of sessions.data) {
        await this.stripe.checkout.sessions.expire(session.id, { stripeAccount });
      }
      // Then cancel the payment intent
      await this.stripe.paymentIntents.cancel(payment.externalId, { stripeAccount });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  getPaymentPaidStatus(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  getPaymentDetails(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }
}
