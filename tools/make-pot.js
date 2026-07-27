#!/usr/bin/env node
/*
 * Regenerates po/linear@ashex.pot.
 *
 * The Spices repository ships cinnamon-spices-makepot, which is what the
 * maintainers run and what CI checks against. That script only exists
 * inside a Spices checkout, so this is the standalone equivalent: it
 * extracts the same two sources cinnamon-xlet-makepot does, the _() and
 * ngettext() calls in the JavaScript and the description, tooltip and
 * combobox option strings in settings-schema.json.
 *
 * Run with: node tools/make-pot.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const UUID = 'linear@ashex';
const ROOT = path.join(__dirname, '..', UUID, 'files', UUID);
const OUTPUT = path.join(ROOT, 'po', UUID + '.pot');

const entries = new Map();

function add(msgid, msgidPlural, reference) {
    if (!msgid)
        return;
    let key = msgid + '\u0000' + (msgidPlural || '');
    if (!entries.has(key)) {
        entries.set(key, {
            msgid: msgid,
            msgidPlural: msgidPlural || null,
            references: [],
        });
    }
    let entry = entries.get(key);
    if (reference && entry.references.indexOf(reference) === -1)
        entry.references.push(reference);
}

/*
 * Unescapes a JavaScript string literal body. Only the escapes the desklet
 * actually uses need handling; anything else is passed through, which is
 * what keeps a stray backslash from silently eating a character.
 */
function unescape(raw) {
    return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, function (match, code) {
        switch (code[0]) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case '\\': return '\\';
            case "'": return "'";
            case '"': return '"';
            case 'u': return String.fromCharCode(parseInt(code.slice(1), 16));
            case 'x': return String.fromCharCode(parseInt(code.slice(1), 16));
            default: return code;
        }
    });
}

const STRING = "(?:'((?:[^'\\\\]|\\\\.)*)'|\"((?:[^\"\\\\]|\\\\.)*)\")";

function scanJavaScript(file, reference) {
    let source = fs.readFileSync(file, 'utf8');

    // ngettext first: its opening looks like a _() call to a lazier pattern.
    let plural = new RegExp('\\bngettext\\s*\\(\\s*' + STRING + '\\s*,\\s*' + STRING, 'g');
    let match;
    while ((match = plural.exec(source)) !== null) {
        let singular = unescape(match[1] !== undefined ? match[1] : match[2]);
        let many = unescape(match[3] !== undefined ? match[3] : match[4]);
        add(singular, many, reference);
    }

    let single = new RegExp('(?<![\\w$.])_\\s*\\(\\s*' + STRING + '\\s*\\)', 'g');
    while ((match = single.exec(source)) !== null)
        add(unescape(match[1] !== undefined ? match[1] : match[2]), null, reference);
}

function scanSchema(file, reference) {
    let schema = JSON.parse(fs.readFileSync(file, 'utf8'));

    Object.keys(schema).forEach(function (key) {
        let node = schema[key];
        if (!node || typeof node !== 'object')
            return;

        ['description', 'tooltip', 'units'].forEach(function (field) {
            if (typeof node[field] === 'string')
                add(node[field], null, reference);
        });

        // Combobox and radiogroup labels are the keys, not the values.
        if (node.options && typeof node.options === 'object') {
            Object.keys(node.options).forEach(function (label) {
                add(label, null, reference);
            });
        }
    });
}

function escape(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

function walk(directory, onFile) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
        let full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'po')
                walk(full, onFile);
            return;
        }
        onFile(full);
    });
}

walk(ROOT, function (file) {
    let reference = path.relative(ROOT, file).split(path.sep).join('/');
    if (file.endsWith('.js'))
        scanJavaScript(file, reference);
    else if (path.basename(file) === 'settings-schema.json')
        scanSchema(file, reference);
});

let lines = [
    '# Translation template for ' + UUID + '.',
    '# This file is distributed under the same license as the desklet.',
    '#',
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: ' + UUID + '\\n"',
    '"Report-Msgid-Bugs-To: \\n"',
    '"POT-Creation-Date: ' + new Date().toISOString().slice(0, 10) + ' 00:00+0000\\n"',
    '"PO-Revision-Date: YEAR-MO-DA HO:MI+ZONE\\n"',
    '"Last-Translator: FULL NAME <EMAIL@ADDRESS>\\n"',
    '"Language-Team: LANGUAGE <LL@li.org>\\n"',
    '"Language: \\n"',
    '"MIME-Version: 1.0\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
    '"Plural-Forms: nplurals=INTEGER; plural=EXPRESSION;\\n"',
    '',
];

let sorted = Array.from(entries.values()).sort(function (a, b) {
    return a.msgid < b.msgid ? -1 : (a.msgid > b.msgid ? 1 : 0);
});

sorted.forEach(function (entry) {
    if (entry.references.length)
        lines.push('#: ' + entry.references.join(' '));
    lines.push('msgid "' + escape(entry.msgid) + '"');
    if (entry.msgidPlural) {
        lines.push('msgid_plural "' + escape(entry.msgidPlural) + '"');
        lines.push('msgstr[0] ""');
        lines.push('msgstr[1] ""');
    } else {
        lines.push('msgstr ""');
    }
    lines.push('');
});

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, lines.join('\n'), 'utf8');

console.log('wrote ' + path.relative(process.cwd(), OUTPUT) + ' with ' +
    sorted.length + ' strings');
