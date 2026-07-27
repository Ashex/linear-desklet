/*
 * i18n.js - translation setup.
 *
 * Cinnamon sets the process-wide text domain to "cinnamon", so a bare
 * gettext call looks our strings up in Cinnamon's own catalogue and never
 * finds them. Binding this desklet's UUID as its own domain is what makes
 * the shipped .po files actually reachable at runtime.
 *
 * The domain is bound by the caller rather than hardcoded here. The
 * test-spice script installs a desklet under a "devtest-" prefixed UUID,
 * and a module that assumes its own name ends up reading the catalogue -
 * and, in the case of a hardcoded path, the settings - belonging to the
 * desklet it was copied from.
 */

const Gettext = imports.gettext;
const GLib = imports.gi.GLib;

var DEFAULT_UUID = 'linear@ashex';

let domain = DEFAULT_UUID;

/*
 * Points translation lookups at a specific UUID's catalogue.
 * get_user_data_dir() honours XDG_DATA_HOME and otherwise resolves to the
 * per-user data directory where Cinnamon installs xlet catalogues.
 */
function bind(uuid) {
    domain = uuid || DEFAULT_UUID;
    Gettext.bindtextdomain(domain,
        GLib.build_filenamev([GLib.get_user_data_dir(), 'locale']));
    return domain;
}

// Bind the default immediately so a string looked up before the desklet
// has resolved its own UUID still returns something sensible.
bind(DEFAULT_UUID);

function _(text) {
    return Gettext.dgettext(domain, text);
}

function ngettext(singular, plural, count) {
    return Gettext.dngettext(domain, singular, plural, count);
}
