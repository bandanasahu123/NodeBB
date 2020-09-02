'use strict';

((module) => {
	const User = require.main.require('./src/user');
	const Groups = require.main.require('./src/groups');
	const db = require.main.require('./src/database');
	const authenticationController = require.main.require('./src/controllers/authentication');
	const Settings = require.main.require('./src/settings');

	const url = require('url');
	const uid = require('uid2');
	const async = require('async');
	const request = require('request-promise');
	const CustomStrategy = require('passport-custom');

	const passport = module.parent.require('passport');
	const nconf = module.parent.require('nconf');
	const winston = module.parent.require('winston');

	const constants = {
		name: 'sunbird-oidc',
		callbackURL: '/auth/sunbird-oidc/callback',
		pluginSettingsURL: '/admin/plugins/fusionauth-oidc',
		pluginSettings: new Settings('fusionauth-oidc', '1.0.0', {
			// Default settings
			clientId: null,
			clientSecret: null,
			emailClaim: 'email',
			discoveryBaseURL: null,
			authorizationEndpoint: null,
			tokenEndpoint: null,
			ssoTokenEndpoint: null,
			userInfoEndpoint: null,
			emailDomain: null
		}, false, false),
	};

	const Oidc = {};

	/**
	 * Sets up the router bindings for the settings page
	 * @param params
	 * @param callback
	 */
	Oidc.init = function (params, callback) {
		winston.verbose('Setting up Sunbird OIDC bindings/routes');

		function render(req, res) {
			res.render('admin/plugins/fusionauth-oidc', {
				baseUrl: nconf.get('url'),
			});
		}

		params.router.get(constants.pluginSettingsURL, params.middleware.admin.buildHeader, render);
		params.router.get('/api/admin/plugins/fusionauth-oidc', render);

		callback();
	};

	Oidc.getAccessTokenFromCode = async function (settings, code) {
		const options = {
			method: 'POST',
			url: settings.tokenEndpoint,
			form: {
				grant_type: 'authorization_code',
				client_id: settings.clientId,
				client_secret: settings.clientSecret,
				code: code,
				redirect_uri: settings.callbackURL
			}
		}
		return request(options);
	};

	Oidc.getAccessTokenFromId = async function (settings, id) {
		const tokenUrl = new URL(settings.ssoTokenEndpoint);
		tokenUrl.searchParams.append("id", id);
		const options = {
			method: 'GET',
			url: tokenUrl.href
		}
		return request(options);
	};

	Oidc.getUserInfo = async function (settings, accessToken) {
		const options = {
			method: 'GET',
			url: settings.userInfoEndpoint,
			headers: {
				'Authorization': 'Bearer ' + accessToken
			}
		}
		return request(options);
	};

	/**
	 * Binds the passport strategy to the global passport object
	 * @param strategies The global list of strategies
	 * @param callback
	 */
	Oidc.bindStrategy = function (strategies, callback) {
		winston.verbose('Setting up openid connect');

		callback = callback || function () {
		};

		constants.pluginSettings.sync(function (err) {
			if (err) {
				return callback(err);
			}

			const settings = constants.pluginSettings.getWrapper();

			// If we are missing any settings
			if (!settings.clientId ||
				!settings.clientSecret ||
				!settings.emailClaim ||
				!settings.authorizationEndpoint ||
				!settings.tokenEndpoint ||
				!settings.ssoTokenEndpoint ||
				!settings.userInfoEndpoint ||
				!settings.emailDomain) {
				winston.info('Sunbird SSO will not be available until it is configured!');
				return callback();
			}

			settings.callbackURL = nconf.get('url') + constants.callbackURL;

			// // If you call this twice it will overwrite the first.
			passport.use(constants.name, new CustomStrategy(
				async function(req, callback) {
					var profile = {};
					// if request is not yet authenticated, redirect to login page
					if (!req.query || (!req.query.code && !req.query.access_token)) {
						var state = uid(24);
						const authUrl = new URL(settings.authorizationEndpoint);
						authUrl.searchParams.append("client_id", settings.clientId);
						authUrl.searchParams.append("state", state);
						authUrl.searchParams.append("response_type", "code");
						authUrl.searchParams.append("scope", ['openid', settings.emailClaim]);
						authUrl.searchParams.append("redirect_uri", settings.callbackURL);
						req.session.ssoState = state;
						this.redirect(authUrl.href);
					} else {
						var accessToken = "";
						if (req.query.access_token) {
							// if request has access token, use it to fetch user info
							accessToken = req.query.access_token;
						} else if (req.query.id) {
							// if request has id, invoke sunbird session create API to get token for this id
							try {
								var response = await Oidc.getAccessTokenFromId(settings, req.query.id);
								var json = JSON.parse(response);
								accessToken = json.access_token;
							} catch (err) {
								return callback(err);
							}
						} else if (req.query.code) {
							// if request has code, get access token from keycloak
							try {
								var response = await Oidc.getAccessTokenFromCode(settings, req.query.code);
								var json = JSON.parse(response);
								accessToken = json.access_token;
							} catch (err) {
								return callback(err);
							}
						}
						try {
							// fetch user info
							var userInfo = await Oidc.getUserInfo(settings, accessToken);
							console.log('userInfo: ' + userInfo);
							profile = JSON.parse(userInfo);
						} catch (err) {
							return callback(err);
						}

						// username must be present
						if (!profile.preferred_username || profile.preferred_username == '') {
							return callback(new Error('Username was missing from the user.'));
						}

						// construct the email using the username and domain name
						var email = profile.preferred_username + '@' + settings.emailDomain;
						Oidc.login({
							oAuthid: profile.sub,
							username: profile.preferred_username,
							email: email,
							rolesEnabled: settings.rolesClaim && settings.rolesClaim.length !== 0,
							isAdmin: false,
						}, (err, user) => {
							if (err) {
								return callback(err);
							}
							authenticationController.onSuccessfulLogin(req, user.uid);
							callback(null, user);
						});
					}
				}
			));

			// If we are doing the update, strategies won't be the right object so
			if (strategies.push) {
				strategies.push({
					name: constants.name,
					url: '/auth/' + constants.name,
					callbackURL: '/auth/' + constants.name + '/callback',
					icon: 'fa-openid',
					scope: ['openid', settings.emailClaim],
					checkState: true,
				});
			}

			callback(null, strategies);
		});
	};

	Oidc.login = function (payload, callback) {
		async.waterfall([
			// Lookup user by existing oauthid
			(callback) => Oidc.getUidByOAuthid(payload.oAuthid, callback),
			// Skip if we found the user in the pevious step or create the user
			function (uid, callback) {
				if (uid !== null) {
					// Existing user
					callback(null, uid);
				} else {
					// New User
					if (!payload.email) {
						return callback(new Error('The email was missing from the user, we cannot log them in.'));
					}

					async.waterfall([
						(callback) => User.getUidByEmail(payload.email, callback),
						function (uid, callback) {
							if (!uid) {
								User.create({
									username: payload.username,
									email: payload.email,
								}, callback);
							} else {
								callback(null, uid); // Existing account -- merge
							}
						},
						function (uid, callback) {
							// Save provider-specific information to the user
							User.setUserField(uid, constants.name + 'Id', payload.oAuthid);
							db.setObjectField(constants.name + 'Id:uid', payload.oAuthid, uid);

							callback(null, uid);
						},
					], callback);
				}
			},
			// Get the users membership status to admins
			(uid, callback) => Groups.isMember(uid, 'administrators', (err, isMember) => {
				callback(err, uid, isMember);
			}),
			// If the plugin is configured to use roles, add or remove them from the admin group (if necessary)
			(uid, isMember, callback) => {
				if (payload.rolesEnabled) {
					if (payload.isAdmin === true && !isMember) {
						Groups.join('administrators', uid, (err) => {
							callback(err, uid);
						});
					} else if (payload.isAdmin === false && isMember) {
						Groups.leave('administrators', uid, (err) => {
							callback(err, uid);
						});
					} else {
						// Continue
						callback(null, uid);
					}
				} else {
					// Continue
					callback(null, uid);
				}
			},
		], function (err, uid) {
			if (err) {
				return callback(err);
			}
			callback(null, {
				uid: uid,
			});
		});
	};

	Oidc.getUidByOAuthid = function (oAuthid, callback) {
		db.getObjectField(constants.name + 'Id:uid', oAuthid, (err, uid) => {
			if (err) {
				return callback(err);
			}
			callback(null, uid);
		});
	};

	Oidc.deleteUserData = function (data, callback) {
		async.waterfall([
			async.apply(User.getUserField, data.uid, constants.name + 'Id'),
			(oAuthIdToDelete, next) => {
				db.deleteObjectField(constants.name + 'Id:uid', oAuthIdToDelete, next);
			},
		], (err) => {
			if (err) {
				winston.error('[sso-oauth] Could not remove OAuthId data for uid ' + data.uid + '. Error: ' + err);
				return callback(err);
			}

			callback(null, data);
		});
	};

	// If this filter is not there, the deleteUserData function will fail when getting the oauthId for deletion.
	Oidc.whitelistFields = function (params, callback) {
		params.whitelist.push(constants.name + 'Id');
		callback(null, params);
	};

	Oidc.bindMenuOption = function (header, callback) {
		winston.verbose('Binding menu option');
		header.authentication.push({
			route: constants.pluginSettingsURL.replace('/admin', ''), // They will add the /admin for us
			name: 'Sunbird SSO',
		});

		callback(null, header);
	};

	Oidc.redirectLogout = function (payload, callback) {
		const settings = constants.pluginSettings.getWrapper();

		if (settings.logoutEndpoint) {
			winston.verbose('Changing logout to OpenID logout');
			let separator;
			if (settings.logoutEndpoint.indexOf('?') === -1) {
				separator = '?';
			} else {
				separator = '&';
			}
			payload.next = settings.logoutEndpoint + separator + 'client_id=' + settings.clientId;
		}

		return callback(null, payload);
	};

	module.exports = Oidc;
})(module);
