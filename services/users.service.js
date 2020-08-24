"use strict";

const { MoleculerClientError } = require("moleculer").Errors;

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const DbService = require("moleculer-db");
const MongooseAdapter = require("moleculer-db-adapter-mongoose");
const User = require("../models/user.model");
const crypto = require('crypto')
// const CacheCleanerMixin = require("../mixins/cache.cleaner.mixin");

module.exports = {
	name: "users",
	mixins: [
		DbService
	],
	adapter: new MongooseAdapter(/*process.env.MONGO_URI ||*/"mongodb://localhost:27017/msv", { useNewUrlParser: true, useUnifiedTopology: true }),
	model: User,

	/**
	 * Default settings
	 */
	settings: {
		/** REST Basepath */
		rest: "/",
		/** Secret for JWT */
		JWT_SECRET: process.env.JWT_SECRET || "jwt-conduit-secret",

		/** Public fields */
		fields: ["_id", "username", "git_id", "email", "twitter", "avatar"],

		/** Validator schema for entity */
		entityValidator: {
			username: { type: "string", min: 2 },
			git_id: { type: "string", min: 2 },
			password: { type: "string", min: 6 },
			email: { type: "email" },
			avatar: { type: "string", optional: true },
			twitter: { type: "string", optional: true },
		}
	},

	/**
	 * Actions
	 */
	actions: {
		/**
		 * Register a new user
		 *
		 * @actions
		 * @param {Object} user - User entity
		 *
		 * @returns {Object} Created entity & token
		 */
		create: {
			rest: "POST /users",
			params: {
				user: { type: "object" }
			},
			async handler(ctx) {
				let entity = ctx.params.user;
				console.log(entity);
				await this.validateEntity(entity);
				if (entity.username) {
					const found = await this.adapter.findOne({ username: entity.username });
					if (found)
						throw new MoleculerClientError("Username is exist!", 422, "", [{ field: "username", message: "is exist" }]);
				}

				if (entity.email) {
					const found = await this.adapter.findOne({ email: entity.email });
					if (found)
						throw new MoleculerClientError("Email is exist!", 422, "", [{ field: "email", message: "is exist" }]);
				}

				entity.password = bcrypt.hashSync(entity.password, 10);
				entity.bio = entity.bio || "";
				entity.image = entity.image || null;
				entity.createdAt = new Date();

				const doc = await this.adapter.insert(entity);
				const user = await this.transformDocuments(ctx, {}, doc);
				const json = await this.transformEntity(user, true, ctx.meta.token);
				await this.entityChanged("created", json, ctx);
				return json;
			}
		},

		/**
		 * Login with username & password
		 *
		 * @actions
		 * @param {Object} user - User credentials
		 *
		 * @returns {Object} Logged in user with token
		 */
		login: {
			rest: "POST /users/login",
			params: {
				user: {
					type: "object", props: {
						email: { type: "email" },
						password: { type: "string", min: 1 }
					}
				}
			},
			async handler(ctx) {
				const { email, password } = ctx.params.user;

				const user = await this.adapter.findOne({ email });
				if (!user)
					throw new MoleculerClientError("Email or password is invalid!", 422, "", [{ field: "email", message: "is not found" }]);

				const res = await bcrypt.compare(password, user.password);
				if (!res)
					throw new MoleculerClientError("Wrong password!", 422, "", [{ field: "email", message: "is not found" }]);

				// Transform user entity (remove password and all protected fields)
				const doc = await this.transformDocuments(ctx, {}, user);
				return await this.transformEntity(doc, true, ctx.meta.token);
			}
		},

		/**
		 * Get user by JWT token (for API GW authentication)
		 *
		 * @actions
		 * @param {String} token - JWT token
		 *
		 * @returns {Object} Resolved user
		 */
		resolveToken: {
			cache: {
				keys: ["token"],
				ttl: 60 * 60 // 1 hour
			},
			params: {
				token: "string"
			},
			async handler(ctx) {
				const decoded = await new this.Promise((resolve, reject) => {
					jwt.verify(ctx.params.token, this.settings.JWT_SECRET, (err, decoded) => {
						if (err)
							return reject(err);

						resolve(decoded);
					});
				});

				if (decoded.id)
					return this.getById(decoded.id);
			}
		},

		/**
		 * Get current user entity.
		 * Auth is required!
		 *
		 * @actions
		 *
		 * @returns {Object} User entity
		 */
		me: {
			auth: "required",
			rest: "GET /user",
			// cache: {
			// 	keys: ["#userID"]
			// },
			async handler(ctx) {
				console.log(ctx)
				const user = await this.getById(ctx.meta.user1._id);
				if (!user)
					throw new MoleculerClientError("User not found!", 400);

				const doc = await this.transformDocuments(ctx, {}, user);
				return await this.transformEntity(doc, true, ctx.meta.token);
			}
		},

		/**
		 * Update current user entity.
		 * Auth is required!
		 *
		 * @actions
		 *
		 * @param {Object} user - Modified fields
		 * @returns {Object} User entity
		 */
		updateMyself: {
			auth: "required",
			rest: "PUT /user",
			params: {
				user: {
					type: "object", props: {
						username: { type: "string", min: 2, optional: true, pattern: /^[a-zA-Z0-9]+$/ },
						password: { type: "string", min: 6, optional: true },
						email: { type: "email", optional: true },
						avatar: { type: "string", optional: true },
						twitter: { type: "string", optional: true },
					}
				}
			},
			async handler(ctx) {
				const newData = ctx.params.user;
				if (newData.username) {
					const found = await this.adapter.findOne({ username: newData.username });
					if (found && found._id.toString() !== ctx.meta.user1._id.toString())
						throw new MoleculerClientError("Username is exist!", 422, "", [{ field: "username", message: "is exist" }]);
				}

				if (newData.email) {
					const found = await this.adapter.findOne({ email: newData.email });
					if (found && found._id.toString() !== ctx.meta.user1._id.toString())
						throw new MoleculerClientError("Email is exist!", 422, "", [{ field: "email", message: "is exist" }]);
				}
				newData.updatedAt = new Date();
				const update = {
					"$set": newData
				};
				const doc = await this.adapter.updateById(ctx.meta.user1._id, update);

				const user = await this.transformDocuments(ctx, {}, doc);
				const json = await this.transformEntity(user, true, ctx.meta.token);
				await this.entityChanged("updated", json, ctx);
				return json;
			}
		},

		list: {
			rest: "GET /users"
		},

		get: {
			rest: "GET /users/:id"
		},

		update: {
			rest: "PUT /users/:id"
		},

		remove: {
			rest: "DELETE /users/:id"
		},


		/**
		 * Get a user profile.
		 *
		 * @actions
		 *
		 * @param {String} username - Username
		 * @returns {Object} User entity
		 */
		getbygitID: {

			params: {
				id: { type: "string" }
			},
			async handler(ctx) {
				const user = await this.adapter.findOne({ git_id: ctx.params.id });
				if (!user)
					throw new MoleculerClientError("User not found!", 404);

				const doc = await this.transformDocuments(ctx, {}, user);
				return doc;
			}
		}

	},

	/**
	 * Methods
	 */
	methods: {
		/**
		 * Generate a JWT token from user entity
		 *
		 * @param {Object} user
		 */
		generateJWT(user) {
			const today = new Date();
			const exp = new Date(today);
			exp.setDate(today.getDate() + 60);

			return jwt.sign({
				id: user._id,
				username: user.username,
				exp: Math.floor(exp.getTime() / 1000)
			}, this.settings.JWT_SECRET);
		},

		/**
		 * Transform returned user entity. Generate JWT token if neccessary.
		 *
		 * @param {Object} user
		 * @param {Boolean} withToken
		 */
		transformEntity(user, withToken, token) {
			if (user) {
				user.avatar = user.avatar || "https://www.gravatar.com/avatar/" + crypto.createHash("md5").update(user.email).digest("hex") + "?d=robohash";

				if (withToken)
					user.token = token || this.generateJWT(user);
			}

			return { user };
		}
	}
};
