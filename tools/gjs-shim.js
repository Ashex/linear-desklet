/*
 * A minimal GJS environment, so the desklet's pure logic modules can be
 * exercised outside Cinnamon.
 *
 * The modules under test are plain GJS scripts: they declare with `var` and
 * reach for globals like `imports`, `require` and `String.prototype.format`.
 * Running each one in its own vm context, under the same 'use strict'
 * wrapper Cinnamon applies, reproduces how GJS actually loads them without
 * pulling in Clutter or St.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB_DIR = path.join(__dirname, '..', 'linear@ashex', 'files', 'linear@ashex', 'lib');

// GJS extends String with a printf-style format method that the desklet
// uses for every interpolated string. Each vm context gets its own String
// intrinsic, so the patch has to be applied inside the context rather than
// out here: a string literal created in there does not see the host's
// String.prototype.
const FORMAT_PATCH = `
Object.defineProperty(String.prototype, 'format', {
    value: function () {
        var args = Array.prototype.slice.call(arguments);
        var index = 0;
        return String(this).replace(/%([sdif%])/g, function (match, kind) {
            if (kind === '%')
                return '%';
            var value = args[index++];
            if (kind === 'd' || kind === 'i')
                return String(Math.round(Number(value)));
            if (kind === 'f')
                return String(Number(value));
            return String(value);
        });
    },
    writable: true,
    configurable: true,
});
`;

const logs = { errors: [], warnings: [] };

const imports = {

    gettext: {
        bindtextdomain: function () {},
        dgettext: function (domain, text) { return text; },
        dngettext: function (domain, singular, plural, count) {
            return count === 1 ? singular : plural;
        },
    },
    gi: {
        GLib: {
            get_language_names: function () {
                return ['en_US.UTF-8', 'en_US', 'en', 'C'];
            },
            build_filenamev: function (parts) { return parts.join('/'); },
            get_user_data_dir: function () { return '/tmp/data'; },
            get_user_cache_dir: function () { return '/tmp/cache'; },
            get_user_state_dir: function () { return '/tmp/state'; },

            /*
             * Real implementations rather than stubs. The PKCE challenge is
             * the one value that must byte-for-byte match what Linear
             * computes, so a fake hash here would make the test prove
             * nothing at all.
             */
            ChecksumType: { SHA256: 'sha256' },
            compute_checksum_for_bytes: function (type, bytes) {
                return crypto.createHash('sha256')
                    .update(Buffer.from(bytes.__data)).digest('hex');
            },
            base64_encode: function (bytes) {
                return Buffer.from(bytes).toString('base64');
            },
            Bytes: function (value) {
                this.__data = typeof value === 'string'
                    ? Buffer.from(value, 'utf8') : Buffer.from(value);
                this.get_size = () => this.__data.length;
                this.get_data = () => this.__data;
            },

            PRIORITY_DEFAULT: 0,
            SOURCE_REMOVE: false,
            SOURCE_CONTINUE: true,
            timeout_add_seconds: function () { return 0; },
            source_remove: function () {},
        },
        Gio: {
            /*
             * Enough of Gio.File for oauth.js to read /dev/urandom. Backed
             * by Node's CSPRNG rather than a fixed buffer, so the test that
             * two tokens differ is testing something real.
             */
            File: {
                new_for_path: function (filePath) {
                    return {
                        read: function () {
                            return {
                                read_bytes: function (count) {
                                    let data = filePath === '/dev/urandom'
                                        ? crypto.randomBytes(count)
                                        : Buffer.alloc(count);
                                    return { get_data: function () { return data; } };
                                },
                                close: function () {},
                            };
                        },
                    };
                },
            },
        },
        Soup: { MAJOR_VERSION: 3 },
    },
    byteArray: {
        fromString: function (text) { return Buffer.from(text, 'utf8'); },
        toString: function (bytes) { return Buffer.from(bytes).toString('utf8'); },
    },
};

const cinnamonGlobal = {
    logError: function (message) { logs.errors.push(String(message)); },
    logWarning: function (message) { logs.warnings.push(String(message)); },
};

const modules = new Map();

/*
 * Cinnamon injects a `require` into every xlet module. It resolves relative
 * to the xlet's root directory rather than to the requiring file, which is
 * why the modules under test ask for './lib/format' even from inside lib/.
 */
function makeRequire() {
    return function (requestPath) {
        let name = String(requestPath)
            .replace(/^\.\//, '')
            .replace(/^lib\//, '')
            .replace(/\.js$/, '');

        if (!modules.has(name))
            load(name);

        return modules.get(name);
    };
}

function load(name) {
    if (modules.has(name))
        return modules.get(name);

    let source = fs.readFileSync(path.join(LIB_DIR, name + '.js'), 'utf8');

    let sandbox = {
        imports: imports,
        global: cinnamonGlobal,
        console: console,
        Intl: Intl,
        Buffer: Buffer,
        require: makeRequire(),
    };

    let context = vm.createContext(sandbox);
    vm.runInContext(FORMAT_PATCH, context, { filename: 'format-patch.js' });

    /*
     * Cinnamon wraps every module in 'use strict' and then auto-exports each
     * top level declaration. Reproducing the strict mode matters: it is what
     * turns a stray assignment to an undeclared name into an error here
     * rather than a mystery in the desktop.
     */
    let exported = {};
    modules.set(name, exported);

    vm.runInContext("'use strict';" + source, context, { filename: name + '.js' });

    Object.keys(sandbox).forEach(function (key) {
        if (key === 'imports' || key === 'global' || key === 'console' ||
            key === 'Intl' || key === 'require' || key === 'Buffer')
            return;
        if (sandbox[key] === undefined)
            return;
        exported[key] = sandbox[key];
    });

    return exported;
}

module.exports = { load: load, imports: imports, logs: logs };
