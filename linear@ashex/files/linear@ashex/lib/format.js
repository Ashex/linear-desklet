/*
 * format.js - turns instants, dates and durations into the short,
 * glanceable strings the desklet is made of.
 */

const GLib = imports.gi.GLib;

// Paths are relative to the desklet directory rather than to this file:
// Cinnamon's require keeps the requiring xlet's root as its base.
const I18n = require('./lib/i18n');

const _ = I18n._;
const ngettext = I18n.ngettext;

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;

function localeName() {
    let names = GLib.get_language_names();
    for (let i = 0; i < names.length; i++) {
        let candidate = names[i].split('.')[0].replace('_', '-');
        if (candidate && candidate !== 'C' && candidate !== 'POSIX')
            return candidate;
    }
    return 'en-US';
}

let _monthDay = null;

function monthDayFormatter() {
    if (_monthDay)
        return _monthDay;
    try {
        _monthDay = new Intl.DateTimeFormat(localeName(), { day: 'numeric', month: 'short' });
    } catch (e) {
        _monthDay = null;
    }
    return _monthDay;
}

function startOfLocalDay(ms, offsetDays) {
    let date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    if (offsetDays)
        date.setDate(date.getDate() + offsetDays);
    return date.getTime();
}

/*
 * Linear's dueDate is a TimelessDate: the string "2026-07-30" with no
 * time and no zone. Handing that to Date.parse gives midnight UTC, which
 * lands on the previous day for anyone west of Greenwich and makes an
 * issue look overdue a day early. Building the date from its parts keeps
 * it in local time, where the user's idea of "today" actually lives.
 */
function parseTimelessDate(text) {
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
    if (!match)
        return null;

    let year = Number(match[1]);
    let month = Number(match[2]);
    let day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return null;

    let date = new Date(year, month - 1, day, 0, 0, 0, 0);
    // A rolled-over date means the day never existed, such as 31 February.
    if (date.getMonth() !== month - 1 || date.getDate() !== day)
        return null;

    return date;
}

function parseTimestamp(text) {
    if (!text)
        return null;
    let ms = Date.parse(text);
    return isNaN(ms) ? null : ms;
}

// Whole days between two instants, counted in calendar days rather than
// elapsed time: at 23:00 an issue due tomorrow is one day away, not zero.
function dayDelta(nowMs, targetMs) {
    return Math.round((startOfLocalDay(targetMs) - startOfLocalDay(nowMs)) / DAY);
}

/*
 * How long ago something happened, in the shortest form that is still
 * unambiguous. Used for the refresh time and for mention timestamps,
 * where the exact instant matters far less than the order of magnitude.
 */
function since(deltaMs) {
    if (deltaMs < 0)
        deltaMs = 0;

    if (deltaMs < 45 * 1000)
        return _('just now');

    if (deltaMs < HOUR) {
        let minutes = Math.max(1, Math.round(deltaMs / MINUTE));
        return ngettext('%d minute ago', '%d minutes ago', minutes).format(minutes);
    }

    if (deltaMs < DAY) {
        let hours = Math.max(1, Math.round(deltaMs / HOUR));
        return ngettext('%d hour ago', '%d hours ago', hours).format(hours);
    }

    let days = Math.max(1, Math.round(deltaMs / DAY));
    if (days < 30)
        return ngettext('%d day ago', '%d days ago', days).format(days);

    let months = Math.max(1, Math.round(days / 30));
    return ngettext('%d month ago', '%d months ago', months).format(months);
}

// The same thing again, compact enough to sit at the end of a list row
// without pushing the title into an ellipsis.
function sinceShort(deltaMs) {
    if (deltaMs < 0)
        deltaMs = 0;
    if (deltaMs < MINUTE)
        return _('now');
    if (deltaMs < HOUR)
        return _('%dm').format(Math.max(1, Math.round(deltaMs / MINUTE)));
    if (deltaMs < DAY)
        return _('%dh').format(Math.max(1, Math.round(deltaMs / HOUR)));
    if (deltaMs < 30 * DAY)
        return _('%dd').format(Math.max(1, Math.round(deltaMs / DAY)));
    return _('%dmo').format(Math.max(1, Math.round(deltaMs / (30 * DAY))));
}

function monthDay(date) {
    let formatter = monthDayFormatter();
    if (formatter) {
        try {
            return formatter.format(date);
        } catch (e) {
            // Fall through to the numeric form below.
        }
    }
    return (date.getMonth() + 1) + '/' + date.getDate();
}

/*
 * A due date phrased the way a person would say it. Anything beyond a
 * week is given as a date, because "in 23 days" is harder to act on than
 * the day itself.
 */
function dueText(dueDate, nowMs) {
    if (!dueDate)
        return '';

    let delta = dayDelta(nowMs, dueDate.getTime());

    if (delta < 0) {
        let overdue = -delta;
        if (overdue === 1)
            return _('Due yesterday');
        return ngettext('%d day overdue', '%d days overdue', overdue).format(overdue);
    }
    if (delta === 0)
        return _('Due today');
    if (delta === 1)
        return _('Due tomorrow');
    if (delta <= 7)
        return ngettext('Due in %d day', 'Due in %d days', delta).format(delta);

    return _('Due %s').format(monthDay(dueDate));
}

// The compact form for list rows, where the word "due" is implied by the
// column it sits in.
function dueTextShort(dueDate, nowMs) {
    if (!dueDate)
        return '';

    let delta = dayDelta(nowMs, dueDate.getTime());
    if (delta < 0)
        return _('Overdue');
    if (delta === 0)
        return _('Today');
    if (delta === 1)
        return _('Tomorrow');
    if (delta <= 7)
        return _('%dd').format(delta);
    return monthDay(dueDate);
}

/*
 * Initials for the avatar beside a mention. Takes the first letter of the
 * first and last words, which is right for "Priya Raman" and harmless for
 * a single-word display name.
 */
function initials(name) {
    let words = String(name || '').trim().split(/\s+/).filter(function (word) {
        return word.length > 0;
    });

    if (!words.length)
        return '?';

    let first = words[0].charAt(0);
    if (words.length === 1)
        return first.toUpperCase();

    return (first + words[words.length - 1].charAt(0)).toUpperCase();
}

/*
 * Linear's priority scale, spelled out. The API returns priorityLabel
 * already localised for the workspace, so that is preferred when present;
 * this is the fallback, and the source of the short eyebrow text.
 */
function priorityLabel(priority) {
    switch (Number(priority)) {
        case 1: return _('Urgent');
        case 2: return _('High');
        case 3: return _('Medium');
        case 4: return _('Low');
        default: return _('No priority');
    }
}

function truncate(text, limit) {
    let value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!limit || value.length <= limit)
        return value;
    return value.substring(0, Math.max(1, limit - 1)) + '\u2026';
}
