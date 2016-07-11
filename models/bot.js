var Promise = require('bluebird');
var config = require('../config');
var db = require('../lib/db');
var convo_model = require('./conversation');
var message_model = require('./message');
var user_model = require('./user');
var zip_model = require('./zip');
var error = require('../lib/error');
var util = require('../lib/util');
var language = require('../lib/language');
var log = require('../lib/logger');

// holds conversation chains. essentially, each "step" in the chain defines a
// part of the conversation (generally a question) and how to process the answer.
// this processing step can store data in various places as well as determine
// the next step in the conversationt to run.
//
// note that the `msg` string can template in variables of user data. for
// instance, we do things like:
//
//   msg: 'hello {{fullname}}! how is the weather in {{settings.city}}?'
var chains = {
	vote_1: {
		_start: 'intro_direct',
		intro_direct: {
			msg: 'Hi! Let\'s get you registered to vote. What\'s your first name?',
			process: simple_store('user.first_name', 'last_name', 'Please enter your first name')
		},
		intro_refer: {
			msg: 'Hi! One of your friends has asked me to help you get registered to vote. What\'s your first name?',
			process: simple_store('user.first_name', 'last_name', 'Please enter your first name')
		},
		last_name: {
			msg: 'What\'s your last name?',
			process: simple_store('user.last_name', 'zip', 'Please enter your last name')
		},
		zip: {
			msg: 'What\'s your zip code?',
			process: simple_store('user.settings.zip', 'address', 'Please enter your zip code', {validate: validate_zip})
		},
		address: {
			msg: 'What\'s your street address? (including apartment #, if any)',
			process: simple_store('user.settings.address', 'city', 'Please enter your street address')
		},
		city: {
			pre_process: function(action, conversation, user) {
				if(util.object.get(user, 'settings.city')) return {next: 'state'};
			},
			msg: 'What city do you live in?',
			process: simple_store('user.settings.city', 'state', 'Please enter your city')
		},
		state: {
			pre_process: function(action, conversation, user) {
				if(util.object.get(user, 'settings.state')) return {next: 'dob'};
			},
			msg: 'What state do you live in? (eg CA)',
			process: simple_store('user.settings.state', 'dob', 'Please enter your state')
		},
		date_of_birth: {
			msg: 'When were you born? (MM/DD/YYYY)',
			process: simple_store('user.settings.date_of_birth', 'email', 'Please enter your date of birth', {validate: validate_date})
		},
		email: {
			msg: 'What\'s your email address?',
			process: simple_store('user.settings.email', 'per_state', 'Please enter your email address', {validate: validate_email})
		},
		// this is a MAGICAL step. it never actually runs, but instead just
		// points to other steps until it runs out of per-state questions to
		// ask. then it parties.
		per_state: {
			pre_process: function(action, conversation, user) {
				var state = util.object.get(user, 'settings.state').trim().toLowerCase();
				var state_questions = vote_per_state[state];

				// who likes to party?
				var next_default = {next: 'party'};

				// no per-state questions? skip!!l
				if(!state_questions) return next_default;

				// loop over the per-state questions, skipping any we have
				// already processed. if we get to the end of the list, we
				// load our next step.
				var next = null;
				for(var i = 0; i < state_questions.length; i++)
				{
					var key = state_questions[i];
					var exists = util.object.get(user, 'settings.'+key);
					// if we already have this answer, skip
					if(exists !== undefined) continue;
					next = key;
					break;
				}
				if(next) return {next: next};

				// nothing left, let's party
				return next_default;
			}
		},
		party: {
			msg: 'What\'s your party preference? (democrat/republican/libertarian/green/other/none)',
			process: simple_store('user.settings.political_party', 'mail', 'Please let us know your party preference')
		},
		mail: {
			msg: 'Would you like to vote by mail-in ballot?',
			process: simple_store('user.settings.mail_in', 'done', '', {validate: validate_boolean})
		},
		done: {
			msg: 'Thanks! We\'ll begin processing your registration! Share this bot to get your friends registered too: https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(config.app.url),
			final: true
		},

		// per-state questions
		// !!!!!!!!
		// !!NOTE!! these *HAVE* to store their value in settings.{{name}} where
		// {{name}} is the same as the key name in the conversation object.
		// in other words, the `us_citizen` conversation step needs to store its
		// value in `user.settings.us_citizen` or the bot will infinite loop
		// !!!!!!!!
		us_citizen: {
			msg: 'Are you a US citizen?',
			process: simple_store('user.settings.us_citizen', 'per_state', '', {validate: validate_boolean_yes})
		},
		legal_resident: {
			msg: 'Are you a current legal resident of {{settings.state}}?',
			process: simple_store('user.settings.legal_resident', 'per_state', '', {validate: validate_boolean_yes})
		},
		will_be_18: { 
			msg: 'Are you 18 or older, or will you be by the date of the election?',
			process: simple_store('user.settings.will_be_18', 'per_state', '', {validate: validate_boolean_yes})
		},
		ethnicity: {
			msg: 'What is your ethnicity or race? (asian-pacific/black/hispanic/native-american/white/multi-racial/other)',
			process: simple_store('user.settings.ethnicity', 'per_state')
			// don't try to validate here, just votebot-api will transform to state specific format
		},
		disenfranchised: {
			msg: 'Are you currently disenfranchised from voting (for instance due to a felony conviction)?',
			process: simple_store('user.settings.disenfranchised', 'per_state', '', {validate: validate_boolean_no})
		},
		incompetent: {
			msg: 'Have you been found legally incompetent in your state?',
			process: simple_store('user.settings.incompetent', 'per_state', '', {validate: validate_boolean_no})
		},
		state_id: {
			msg: 'What\'s your {{settings.state}} driver\'s license (or state ID) number?',
			process: simple_store('user.settings.state_id', 'per_state', 'Please enter your state ID number')
		},
		state_id_issue_date: {
			msg: 'What date was your state id/driver\'s license issued? (mm/dd/yyyy)',
			process: simple_store('user.settings.state_id_issue_date', 'per_state', '', {validate: validate_date})
		},
		ssn: {
			msg: 'What\'s your SSN?',
			process: simple_store('user.settings.ssn', 'per_state', '', {validate: validate_ssn})
		},
		ssn_last4: {
			msg: 'What are the last 4 digits of your SSN?',
			process: simple_store('user.settings.ssn_last4', 'per_state', 'Please enter the last 4 digits of your SSN')
		},
		state_id_or_ssn_last4: {
			msg: 'What\'s your {{settings.state}} driver\'s license (or state ID) number? If you don\'t have one, enter the last 4 digits of your SSN.',
			process: simple_store('user.settings.state_id_or_ssn_last4', 'per_state', 'Please enter your state ID number or last 4 of your SSN')
		},
		gender: {
			msg: 'What\'s your gender?',
			process: simple_store('user.settings.gender', 'per_state', '', {validate: validate_gender})
		},
		county: {
			msg: 'What county do you reside in?',
			process: simple_store('user.settings.county', 'per_state', 'Please enter the name of the county you reside in')
		},
		consent_use_signature: {
			msg: 'May we use your signature on file with the DMV to complete the form with your state?',
			process: simple_store('user.settings.consent_use_signature', 'per_state', 'Please reply Yes to let us request your signature from the DMV. We do not store this information.')
		}
	}
};

// state-specific questions we need to ask after the main flow is completed.
// these are in order of how the questions will be asked, and each item is a
// key in the `chains.vote_1` flow object that loads that question.
var vote_per_state = {
	al: ['us_citizen', '18', 'state_id'],
	ak: ['us_citizen', '18', 'ssn_last4', 'state_id'],
	// TODO: AZ (https://servicearizona.com/unavailable/saz.html currently is broken) THANKS, OBAMA
	//az: [],
	ca: ['us_citizen', 'state_resident', '18', 'ssn_last4', 'state_id'],
	co: ['state_id'],
	ct: ['us_citizen', 'state_resident', '18', 'state_id', 'disenfranchised'],
	de: ['us_citizen', 'state_resident', 'state_id', 'disenfranchised'],
	ga: ['us_citizen', 'state_resident', '18', 'disenfranchised', 'incompetent', 'state_id'],
	hi: ['state_id', 'ssn', 'gender'],
	// TODO IA (stuck behind a login-wall)
	//ia: [],
	il: ['us_citizen', '18', 'state_id', 'state_id_issue_date'],
	in: ['us_citizen', '18', 'state_resident', 'disenfranchised', 'state_id'],
	ks: ['us_citizen', '18', 'state_resident', 'disenfranchised', 'state_id'],
	ky: ['us_citizen', 'state_resident', '18', 'disenfranchised', 'incompetent', 'ssn'],
	la: ['us_citizen', '18', 'disenfranchised', 'incompetent', 'state_id'],
	ma: ['us_citizen', 'state_resident', '18', 'state_id'],
	md: ['us_citizen', 'ssn_last4', 'state_id'],
	mn: ['us_citizen', '18', 'disenfranchised', 'state_id_or_ssn_last4'],
	// TODO: MO got rid of OVR apparently
	//mo: [],
	ne: ['us_citizen', '18', 'state_id'],
	nm: ['us_citizen', 'state_resident', '18', 'disenfranchised', 'state_id', 'ssn'],
	nv: ['us_citizen', 'state_resident', '18', 'state_id', 'ssn_last4'],
	// TODO: NY (stuck behind login-wall)
	//ny: [],
	or: ['us_citizen', '18', 'state_id_or_ssn_last4'],
	// NOTE: requires county field (select box)
	pa: ['us_citizen', '18', 'county', 'state_id_or_ssn_last4', 'disenfranchised'],
	sc: ['state_id', 'ssn', 'gender'],
	// TODO: rest of reg is behind id-wall
	//ut: ['state_id'],
	// NOTE: requires county field (select box)
	va: ['ssn_last4', 'county'],
	wa: ['us_citizen', '18', 'state_id', 'state_id_issue_date'],
	wv: ['us_citizen', 'state_resident', '18', 'disenfranchised', 'incompetent', 'state_id', 'ssn_last4'],
	vt: ['us_citizen', 'state_resident', '18', 'state_id']
};

// a helper for very simple ask-and-store type questions. can perform data
// validation as well.
function simple_store(store, next, errormsg, options)
{
	options || (options = {});
	return function(body)
	{
		// if we get an empty body, error
		if(!body.trim()) return data_error(errormsg, {promise: true});

		var obj = {};
		obj[store] = body;
		var promise = Promise.resolve({next: next, store: obj});
		if(options.validate)
		{
			promise = options.validate(body)
				.spread(function(body, extra_store) {
					extra_store || (extra_store = {});
					extra_store[store] = body;
					return {next: next, store: extra_store};
				});
		}
		return promise;
	};
}

// a useful helper for creating "data errors" ie, the code is fine, but some
// kind of issue exists in the data the user handed us for validation
function data_error(msg, options)
{
	options || (options = {});

	var err = new Error(msg);
	err.data_error = true;
	if(options.promise) err = Promise.reject(err);
	// this conversation.......is over
	if(options.end) err.end_conversation = true;
	return err;
}

function template(str, data)
{
	return str.replace(/{{(.*?)}}/, function(all, key) {
		var val = util.object.get(data, key);
		return val || '';
	});
}

function validate_date(body)
{
	var date = new Date(body);
	if(date.toString().match(/invalid/i)) return Promise.reject(data_error('We couldn\'t read that date'));

	body = [
		util.left_pad(date.getFullYear(), '0000'),
		util.left_pad(date.getMonth() + 1, '00'),
		util.left_pad(date.getDate(), '00'),
	].join('/');
	return Promise.resolve([body]);
};

function validate_email(body)
{
	var email = body.match(/@/);
	if(email[0]) return Promise.resolve([email]);
	return data_error('Please enter your email address', {promise: true});
}

function validate_boolean(body)
{
	return Promise.resolve([!!language.is_yes(body)]);
}

function validate_boolean_yes(body)
{
	return Promise.resolve([language.is_yes(body), language.is_no(body)])
		.spread(function(is_yes, is_no) {
			if(!is_yes && !is_no) throw data_error('Please answer yes or no');
			if(!is_yes) throw data_error('Sorry, you are not eligible to vote in your state', {end: true});
			return [true];
		})
}

function validate_boolean_no(body)
{
	return Promise.resolve([language.is_yes(body), language.is_no(body)])
		.spread(function(is_yes, is_no) {
			if(!is_yes && !is_no) throw data_error('Please answer yes or no');
			if(!is_no) throw data_error('Sorry, you are not eligible to vote in your state', {end: true});
			return [false];
		})
}

function validate_zip(body)
{
	var zip = body.replace(/-.*/, '');
	if(!zip.match(/^[0-9]{5}$/)) return Promise.reject(data_error('That zip code isn\'t valid'));
	return zip_model.find(zip)
		.then(function(zipdata) {
			var zip = zipdata.code;
			if(!zip) return reject(data_error('We couldn\'t find that zip code'));

			var places = zipdata.places;
			var setter = {};
			// if we have 0 (or 2 or more) places, we cannot assume a location,
			// so we only populate the city/state fields if we get one location
			if(places.length == 1)
			{
				var place = places[0];
				var city = place.city;
				var state = place.state;
				if(city) setter['user.settings.city'] = city;
				if(state) setter['user.settings.state'] = state;
			}
			return [zip, setter];
		})
		.catch(function(err) { return err && err.message == 'not_found'; }, function(err) {
			throw data_error('We couldn\'t find that zip code');
		});
}

function validate_gender(body)
{
	return Promise.resolve([language.get_gender(body)])
		.tap(function(gender) {
			if(!gender) throw data_error('Please enter your gender as male or female');
		});
}

function validate_ssn(body)
{
	var ssn = body.match(/[0-9]{3}-?[0-9]{2}-?[0-9]{4}/);
	if(ssn[0]) return Promise.resolve([ssn]);
	return data_error('Please enter your SSN', {promise: true});
}

var parse_step = function(step, body)
{
	// if the user is canceling, don't bother parsing anything
	if(language.is_cancel(body)) return Promise.resolve({next: '_cancel'});
	return step.process(body);
};

/**
 * given an action, conversation, and user objects, determine the next step in
 * the conversation chain to load.
 */
var find_next_step = function(action, conversation, user)
{
	var state = conversation.state;
	var next = action.next;

	var key = [state.type, next].join('.');
	var nextstep = util.object.get(chains, key);
	if(!nextstep) throw new Error('bot: could not load step: '+ key);

	var default_step = {step: nextstep, name: next};

	if(!nextstep.pre_process) return default_step;
	// call pre-process on our new step.
	var res = nextstep.pre_process(action, conversation, user);
	if(!res || !res.next) return default_step;

	// if our pre_process returns a "next" key, then we know we should load
	// another step. wicked. recurse and find that shit.
	var action = util.object.merge({}, action, {next: res.next});
	return find_next_step(action, conversation, user);
};

/**
 * start a bot-initiated conversation
 */
exports.start = function(type, to_user_id, options)
{
	options || (options = {});
	var user;
	return user_model.get(to_user_id)
		.then(function(_user) {
			user = _user;
			if(!user) throw error('user '+user_id+' was not found');
			var chain = chains[type];
			var first_step_name = options.start || chain._start;
			var step = chain[first_step_name];
			if(!step) throw new Error('bot: error loading step: '+type+'.'+step);
			return convo_model.create(config.bot.user_id, {
				type: 'bot',
				state: {type: type, step: first_step_name},
				recipients: [user],
				message: { body: step.msg }
			});
		});
};

/**
 * processes an incoming message to our beloved bot. handles loading the convo
 * state, parsing/processing the user's incoming message, and loading the next
 * chain in the conversation.
 */
exports.next = function(user_id, conversation, message)
{
	var user;
	return user_model.get(user_id)
		.then(function(_user) {
			user = _user;
			if(!user) throw error('user '+user_id+' was not found');
			var state = conversation.state;
			var key = [state.type, state.step].join('.');
			var step = util.object.get(chains, key);
			if(!step) throw error('conversation chain missing: '+key);

			// we've reached the final step, do nothing
			// TODO: maybe have some kind of prompt or CTA here?
			if(step.final)
			{
				log.info('bot: recv msg, but conversation finished');
				return;
			}

			var body = message.body;
			return parse_step(step, body)
				.then(function(action) {
					log.info('bot: action: ', JSON.stringify(action));

					// if user wants out, let them
					if(action.next == '_cancel') return convo_model.close(conversation.id);

					var promise = Promise.resolve();

					// if we're storing value(s) into object(s), loop over our
					// setters and set them into the object we're saving.
					//
					// NOTE: currently, you can only run multiple setters on
					// *one object*. so you can do user.name and user.age
					// in one pass, but you cannot do user.name and
					// conversation.date...this code would need to be updated
					// to support this and we just don't need it right now
					if(action.store)
					{
						// a set of objects we're allowed to set via the convo chain
						var setters = {
							user: {
								obj: user,
								set: function(obj) { return user_model.update(user_id, obj); }
							}
						};
						var keys = Object.keys(action.store);
						// grab the object we're setting data into based on
						// the FIRST key in our setter object. as mentioned
						// above, we currently only support setting data
						// into one top-level object
						var obj = keys[0].replace(/\..*/, '');
						var setter = setters[obj];
						if(setter)
						{
							keys.forEach(function(place) {
								// grab the value from our setter
								var value = action.store[place];
								// user.settings.address becomes settings.address
								place = place.replace(/^.*?\./, '');
								// recursively set our value into our main object
								util.object.set(setter.obj, place, value);
							});
							// replace the promise with our async setter
							// function's promise (eg, user_model.update)
							promise = setter.set(setter.obj);
						}
					}

					// we're processing the next step, inject some steps
					// into the promise chain
					promise = promise
						.then(function() {
							// get our next step from the conversation chain
							var found = find_next_step(action, conversation, user);
							var nextstep = found.step;

							// destructively modify our convresation state object,
							// replacing the "step" value with our new step's name.
							// this will get saved once our message goes out
							state.step = found.name;

							// create/send the message from the next step in the convo chain
							return message_model.create(config.bot.user_id, conversation.id, {body: template(nextstep.msg, user)});
						})
						.then(function() {
							// save our current state into the conversation so's
							// we know where we left off when the next message
							// comes in
							return convo_model.update(conversation.id, {state: state});
						});

					// all done
					return promise;
				})
				// catches ALL errors, whether in validation or in code.
				.catch(function(err) {
					if(err.data_error)
					{
						log.notice('bot: next: data error: ', err);
						if(err.end_conversation)
						{
							// TODO: actually end the conversation here
							var message = err.message+'.';
						}
						else
						{
							var message = err.message+'. Please try again!';
						}
					}
					else
					{
						log.error('bot: next: ', err, err.stack);
						var message = 'I seem to have had a glitch. Please send your last message again.';
					}
					return message_model.create(config.bot.user_id, conversation.id, {body: message});
				})
				// error catching errors. ABORT
				.catch(function(err) {
					log.crit('bot: fatal (giving up): ', err, err.stack);
				});
		});
};

