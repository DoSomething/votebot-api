var db = require('../lib/db');
var Promise = require('bluebird');
var error = require('../lib/error');
var message_model = require('./message');
var user_model = require('./user');
var bot_model = require('./bot');

exports.get = function(id)
{
	return db.one('SELECT * FROM conversations WHERE id = {{id}}', {id: id});
};

exports.create = function(user_id, data)
{
	var recipients = data.recipients || [];
	var message = data.message || {};
	if(recipients.length == 0 || !recipients[0].username)
	{
		return Promise.reject(error('Please specify at least one recipient', {code: 400}));
	}

	if(!message.body)
	{
		return Promise.reject(error('Please enter a message to send', {code: 400}));
	}

	var usernames = recipients.map(function(r) { return r.username; });
	var users;
	return user_model.batch_create(usernames)
		.then(function(_users) {
			users = _users;
			var conversation = {
				user_id: user_id,
				type: data.type || 'p2p',
				state: data.state || null,
				created: db.now()
			};
			return db.create('conversations', conversation);
		})
		.then(function(conversation) {
			var user_ids = users.map(function(u) { return u.id; });
			return exports.set_recipients(conversation.id, user_ids)
				.then(function() {
					return message_model.create(user_id, conversation.id, {body: message.body})
				})
				.then(function(message) {
					conversation.messages = [message];
					return conversation;
				})
				.tap(function(conversation) {
					// if we're starting a p2p conversation, init a bot chat to
					// each recipient as well
					if(conversation.type != 'p2p') return;
					return Promise.all(users.map(function(user) {
						return bot_model.start('vote_1', user.id, {start: 'intro_refer'});
					}));
				});
		});
};

exports.update = function(conversation_id, data)
{
	return db.update('conversations', conversation_id, data);
};

/**
 * wipes and recreates all recipients for a conversation
 */
exports.set_recipients = function(conversation_id, user_ids)
{
	var data = {id: conversation_id};
	return db.query('DELETE FROM conversations_recipients WHERE conversation_id = {{id}}', data)
		.then(function() {
			var records = user_ids.map(function(id) {
				return {conversation_id: conversation_id, user_id: id, created: db.now()};
			});
			return db.create('conversations_recipients', records);
		});
};

/**
 * get the most recent conversation a user has participated in
 */
exports.get_recent_by_user = function(user_id)
{
	var qry = [
		'SELECT',
		'	c.*',
		'FROM',
		'	conversations c,',
		'	conversations_recipients cr',
		'WHERE',
		'	c.id = cr.conversation_id AND',
		'	cr.user_id = {{user_id}}',
		'ORDER BY',
		'	cr.created DESC',
		'LIMIT 1'
	];
	return db.one(qry.join('\n'), {user_id: user_id});
};

// TODO: check user can access conversation
// TODO: use pubsub instead of looping DB
exports.poll = function(user_id, conversation_id, last_id, options)
{
	options || (options = {});
	var seconds = options.seconds || 30;

	var start = new Date().getTime();
	var next = function()
	{
		var qry = [
			'SELECT',
			'	m.*',
			'FROM',
			'	messages m',
			'WHERE',
			'	m.conversation_id = {{convo_id}} AND',
			'	m.id > {{last_id}}',
		];
		return db.query(qry.join('\n'), {convo_id: conversation_id, last_id: last_id})
			.then(function(res) {
				if(res.length > 0) return res;
				var now = new Date().getTime();
				if((now - start) > (seconds * 1000)) return [];
				return new Promise(function(resolve, reject) {
					setTimeout(function() {
						resolve(next());
					}, 2000);
				});
			});
	};

	return next();
};

/**
 * end a conversation (set it to inactive)
 */
exports.close = function(conversation_id)
{
	// TODO
	return Promise.resolve();
};

