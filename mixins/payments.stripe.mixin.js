"use strict";

const { MoleculerClientError } = require("moleculer").Errors;
const { result } = require("lodash");
const url = require("url");
const paypal = require("paypal-rest-sdk");
const HelpersMixin = require("./helpers.mixin");
const priceLevels = require("./price.levels.mixin");
const fetch 		= require("node-fetch");

// This is a sample test API key. Sign in to see examples pre-filled with your key.
const stripe = require("stripe")("sk_test_51HRMprJrB6Q7Qa3ptZH61e9Ki3c5RTaqJ0wbG6Umoij9oIQPQU6rtYGrrFZ9JYkjSi03Ow2msGCIWcZ1w6I4y6EL00K5ncXwto");

const pathResolve = require("path").resolve;

let fs = require("fs"); // only temporaly

module.exports = {
	settings: {

		paymentsConfigs: {
			paypal: {
				environment: (process.env.PAYPAL_ENV==="production" || process.env.PAYPAL_ENV==="live") ? "live" : "sandbox",
				merchantId: process.env.PAYPAL_CLIENT_ID,
				publicKey: null,
				privateKey: process.env.PAYPAL_SECRET,
				gateway: null
			}
		}

	},


	mixins: [
		HelpersMixin, 
		priceLevels
	],


	actions: {

		/**
		 * Endpoint for Stripe paymentIntent API
		 *
		 * @actions
		 * 
     * @param {String} orderId - id of order to pay
     * @param {Object} data - data specific for payment
		 * 
		 * @returns {Object} Result from PayPal order checkout
		 */
		stripeOrderPaymentintent: {
			cache: false,
			auth: "required",
			params: {
				orderId: { type: "string", min: 3 },
				data: { type: "object", optional: true }
			},
			handler(ctx) {
				let result = { success: false, url: null, message: "error" };
				let self = this;

				// get order data
				return this.adapter.findById(ctx.params.orderId)
					.then(order => {
						if ( order ) {
							let paymentType = order.data.paymentData.codename.replace("online_stripe_","");

							let items = [];
							let priceTotalNoSubscriptions = 0;
							let priceSubscriptions = 0;
							for (let i=0; i<order.items.length; i++ ) {
								if (order.items[i].type && order.items[i].type=="subscription") {
									if (order.items[i].price && order.items[i].price>0) {
										priceSubscriptions += order.items[i].price;
									}
								} else {
									items.push({
										"name": order.items[i].name[order.lang.code],
										"sku": order.items[i].orderCode,
										"price": order.items[i].price * 100,
										"currency": order.prices.currency.code.toString().toLowerCase(),
										"quantity": order.items[i].amount
									});
								}
							}
							items.push({
								"name": order.data.paymentData.name[order.lang.code],
								"sku": order.data.paymentData.name[order.lang.code],
								"price": order.prices.pricePayment * 100,
								"currency": order.prices.currency.code.toString().toLowerCase(),
								"quantity": 1
							});
							let deliveryName = "Delivery - ";
							if (order.data.deliveryData.codename && order.data.deliveryData.codename.physical) {
								deliveryName += order.data.deliveryData.codename.physical.value;
							}
							if (order.data.deliveryData.codename && order.data.deliveryData.codename.digital) {
								deliveryName += order.data.deliveryData.codename.digital.value;
							}
							items.push({
								"name": deliveryName,
								"sku": deliveryName,
								"price": order.prices.priceDelivery * 100,
								"currency": order.prices.currency.code.toString().toLowerCase(),
								"quantity": 1
							});


							let url = ctx.meta.siteSettings.url;
							if ( process.env.NODE_ENV=="development" ) {
								url = "http://localhost:3000";
							}

							priceTotalNoSubscriptions = (order.prices.priceTotal - priceSubscriptions) * 100;

							let payment = {
								"intent": "sale",
								"payer": {
									"payment_method": paymentType
								},
								"redirect_urls": {
									"cancel_url": url +"/backdirect/order/paypal/cancel",
									"return_url": url +"/backdirect/order/paypal/return"
								},
								"transactions": [{
									"item_list": {
										"items": items
									},
									"amount": {
										"currency": order.prices.currency.code,
										"total": priceTotalNoSubscriptions
									},
									// "note_to_payer": "Order ID "+order._id,
									"soft_descriptor": process.env.SITE_NAME.substr(0,22) // maximum length of accepted string
								}]
							};
							this.logger.info("payments.stripe.mixin paypalOrderCheckout payment / items / amount:", payment, payment.transactions[0].item_list.items, payment.transactions[0].amount);

							return stripe.paymentIntents.create({
								amount: priceTotalNoSubscriptions,
								currency: order.prices.currency.code.toString().toLowerCase()
							})
								.then(pi => {
									this.logger.info("payments.stripe.mixin stripeOrderPaymentintent pi:", pi);
									return {
										clientSecret: pi.client_secret
									};
								});
						} // if order
					});
			}
		},


		
		/**
		 * Reactivate Billing Agreement
		 * 
		 * @actions
		 * 
		 */
		stripeWebhook: {
			cache: false,
			handler(ctx) {
				console.log("params", ctx.params);
				let data = ctx.params.data;
				if ( data.supplier ) { delete data.supplier; }

				let stripeSignature = ctx.options.parentCtx.options.parentCtx.params.req.headers["stripe-signature"];
				this.logger.info("stripeWebhook ----- stripeSignature :", stripeSignature);

				let event;
				try {
					event = stripe.webhooks.constructEvent(data, stripeSignature, process.env.STRIPE_WEBHOOK_ENDPOINT_SECRET);
				}
				catch (err) {
					this.logger.error("Webhook error:", err);
					return Promise.reject(new MoleculerClientError("Webhook error", 400, "", [{ field: "webhook event", message: "failed"}]));
				}

				// Handle the event
				switch (event.type) {
				case "payment_intent.succeeded": {
					const paymentIntent = event.data.object;
					console.log("PaymentIntent was successful!", paymentIntent);
					break;
				}
				case "payment_method.attached": {
					const paymentMethod = event.data.object;
					console.log("PaymentMethod was attached to a Customer!", paymentMethod);
					break;
				}
				// ... handle other event types
				default: {
					console.log(`Unhandled event type ${event.type}`);
				}
				}

				// this.logger.info("path resolve:", pathResolve("./.temp/ipnlog.log"));
				// let log_file = fs.createWriteStream("./.temp/ipnlog.log", {flags : "a"});
				// let date = new Date();
				// log_file.write( "\n\n" + date.toISOString() + " #1:\n"+ JSON.stringify(ctx.params)+"\n");

				/*
				setTimeout(() => {

					return new Promise((resolve, reject) => {
						paypal.notification.webhookEvent.getAndVerify(JSON.stringify(data), function (error, response) {
							if (error) {
								self.logger.error("payments.paypal1.mixin paypalWebhook error: ", error);
								reject(error);
							} else {
								self.logger.info("payments.paypal1.mixin paypalWebhook result: ", response);
								resolve(response);
							}
						});
					})
						.then(response => {
							self.logger.info("payments.paypal1.mixin paypalWebhook response: ", JSON.stringify(response));
							// cancel subscription in DB
							if (response && response==true && ctx.params.data && 
							ctx.params.data.event_type) {
								switch (ctx.params.data.event_type) {
								case "BILLING.PLAN.CREATED":
									self.logger.info("payments.paypal1.mixin paypalWebhook - BILLING.PLAN.CREATED notification received");
									break;
								case "BILLING.PLAN.UPDATED":
									self.logger.info("payments.paypal1.mixin paypalWebhook - BILLING.PLAN.UPDATED notification received");
									break;
								case "BILLING.SUBSCRIPTION.CANCELLED":
									self.paypalWebhookBillingSubscriptionCancelled(ctx);
									break;
								case "PAYMENT.SALE.COMPLETED":
									self.paypalWebhookPaymentSaleCompleted(ctx);
									break;
								default:
									self.logger.info("payments.paypal1.mixin paypalWebhook - notification received:", JSON.stringify(data));
								}
							}
						})
						.catch(error => {
							this.logger.error("payments.paypal1.mixin - paypalWebhook error2: ", JSON.stringify(error));
							let log_file = fs.createWriteStream("./.temp/ipnlog.log", {flags : "a"});
							let date = new Date();
							log_file.write( "\n\n" + date.toISOString() + " #1:\n"+ JSON.stringify(ctx.params)+"\n");
							return null;
						});
				}, 10000); // timeout end
				*/
			}
		},

		


	},


	methods: {

		
	}
};
