var resutil = require('../lib/resutil');
var util = require('../lib/util');
var express = require('express');
var user_model = require('../models/user');
var conversation_model = require('../models/conversation');
var submission_model = require('../models/submission');
var bot_model = require('../models/bot');
var email = require('../lib/email');
var auth = require('../lib/auth');
var log = require('../lib/logger');
var error = require('../lib/error');
var config = require('../config');
var language = require('../lib/language');
var moment = require('moment-timezone');


exports.hook = function(app)
{
    app.post('/receipt/:username', createDelay); // TODO, secure with auth.key shared with votebot-forms
};

var createDelay = function(req, res) {
    setTimeout(function() {
        create(req, res);
    }, config.bot.advance_delay * 2);
}

var create = function(req, res)
{
    var username = req.params.username;
    var form_class = req.body.form_class ? req.body.form_class : 'unknown';
    var status = req.body.status ? req.body.status : 'failure';
    var reference = req.body.reference ? req.body.reference : -1;
    var pdf_url = req.body.pdf_url ? req.body.pdf_url : null;
    var user;
    var goto_step;
    var conversation;
    log.info('receipt: create', req.body);

    submission_model.update_from_receipt(req.body);

    user_model.get_by_username(username).then(function(_user) {
        user = _user;
        return conversation_model.get_recent_by_user(user.id);
    }).then(function(_conversation) {
        conversation = _conversation;

        if (status == "success") {
            var update_user = util.object.set(user, 'settings.submit_success', true);
            update_user = util.object.set(update_user, 'settings.submit_form_type', form_class);
            update_user = util.object.set(update_user, 'complete', true);

            // also update the conversation to be complete
            conversation_model.update(conversation.id, {complete: true});

            goto_step = 'processed';
        } else if (form_class == "NVRA") {
            var update_user = util.object.set(user, 'settings.failed_pdf', true);
            update_user = util.object.set(update_user, 'settings.failure_reference', reference);
            goto_step = 'incomplete';
        } else {
            var update_user = util.object.set(user, 'settings.failed_ovr', true);
            goto_step = 'submit';
        }

        return user_model.update(user.id, update_user);
    }).then(function() {
        return conversation_model.goto_step(conversation.id, goto_step);
    }).then(function(updated_conversation) {
        bot_model.next(user.id, updated_conversation);

        if (status !== 'success') {
            resutil.send(res, 'bummer');
            return;
        }

        var msg_parts = [
            "Thanks for registering to vote with HelloVote!",
        ]

        if (user.settings.submit_form_type === 'NVRA') {
            return email.sendNVRAReceipt(user, pdf_url)
                .then(function(emailResult) {
                    resutil.send(res, emailResult);
                })
                .catch(function(err) {
                    resutil.error(res, 'Problem sending email receipt', err);
                    log.error('Unable to send email receipt', {user_email: [user.settings.email]});
                });
        } else {
            return email.sendOVRReceipt(user, pdf_url)
                .then(function(emailResult) {
                    resutil.send(res, emailResult);
                })
                .catch(function(err) {
                    resutil.error(res, 'Problem sending email receipt', err);
                    log.error('Unable to send email receipt', {user_email: [user.settings.email]});
                });
        }
    });
};

// smarty streets gives us tz like "Pacific", so we have to add links to proper tz names
moment.tz.link([
    'America/Anchorage|Alaska',
    'America/Honolulu|Hawaii',
    'America/Los_Angeles|Pacific',
    'America/Denver|Mountain',
    'America/Chicago|Central',
    'America/New_York|Eastern',
]);
