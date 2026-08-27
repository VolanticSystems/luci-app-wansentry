# Contributing to luci-app-wansentry

Contributions are welcome, including bug reports, and especially the live
failover test described under *Where help is most useful* below.

## Scope, before you start

wansentry is deliberately narrow: **IPv4 failover between exactly two
uplinks, on one screen, with nine fields.** Load balancing, more than two
uplinks, per-destination policy routing and a second mwan3 options editor are
explicit non-goals, argued in [docs/DESIGN.md](docs/DESIGN.md) 1 and 2.

That is not gatekeeping for its own sake. The whole premise is that
`luci-app-mwan3` already exposes every mwan3 feature, and the gap in the
ecosystem is a *simple* front end rather than another complete one. A patch
that adds a tab tends to be a patch that removes the reason this package
exists. If you need the full model, `luci-app-mwan3` is the right tool and
wansentry will step aside for it automatically.

Fixes, correctness improvements, better diagnostics and clearer wording are
all welcome without reservation.

## Reporting a problem

Useful reports include:

- Device, OpenWrt release, and mwan3 version (`apk info mwan3`).
- The generated configuration: `uci show mwan3`.
- wansentry's own settings: `uci show wansentry`.
- `logread -e mwan3` around the event.
- Whether mwan3 was configured by hand before wansentry was installed, since
  wansentry deliberately refuses to manage a configuration it did not create.

## Building

This repository is a single LuCI package with its `Makefile` at the root, the
same layout upstream `openwrt/luci` uses under `applications/`. It drops into
an OpenWrt SDK tree's `package/` directory, which is scanned recursively.

It is **not** a feed: a feed is a directory *containing* package directories,
and adding this repo directly with `src-link` produces an empty feed index.
The CI workflow stages it into a temporary feed for that reason.

    ./scripts/feeds update -a
    ./scripts/feeds install -a
    git clone https://github.com/VolanticSystems/luci-app-wansentry.git \
        package/luci-app-wansentry
    make package/luci-app-wansentry/compile V=s

CI builds against the OpenWrt SDK on every push and pull request.

## Testing a change on a device

The views are plain JS, so no rebuild is needed to iterate:

    # after replacing a view under /www/luci-static/resources/view/wansentry/
    rm -f /tmp/luci-indexcache.*
    /etc/init.d/rpcd restart && /etc/init.d/uhttpd restart

Two behaviours are easy to break and worth re-checking after any change to
the generator or the apply path:

- **Ownership.** wansentry must never modify or delete an mwan3 section it
  did not create. Both `generator.js` (`isOwned`) and
  `/etc/init.d/wansentry` enforce this, and they must agree.
- **All-or-nothing save.** Validation runs *before* anything is staged, so a
  rejected form leaves no partial change to ride out on a later apply from
  another page. This has been broken twice by well-meaning refactors.

Please confirm changes on real hardware. Rollback behaviour in particular
cannot be reasoned about from the source alone: on a LAN-safe apply this LuCI
build auto-confirms as soon as the device is reachable, so a rollback test
has to *provoke* unreachability rather than assume that doing nothing
produces it.

**Then run the suites.** The JavaScript one needs only Node and runs anywhere;
the two shell suites need a sandbox router and must be run one at a time.

    node tests/generator-suite.js     # 54 checks, no router needed
    sh   tests/hardware-suite.sh      # 37 checks: gate, arming, restart, security, pbr, hooks
    sh   tests/ownership-suite.sh     # 29 checks: the ownership rule specifically

`hardware-suite.sh` takes a group name to run one part:
`ownership`, `arming`, `security`, `pbr`, `hooks`, or `all` (the default).

**The `pbr` group needs pbr installed and two distinct uplinks configured.**
Without either it skips and says so, and the run reports how many checks did not
run. Do not treat a skipped group as a passing one; that is how coverage
disappears without anyone deciding to drop it. To run it properly:

    apk add pbr
    uci set wansentry.main.primary=wan
    uci set wansentry.main.backup=<your second uplink>
    uci commit wansentry

The group stands up its own pbr policy pointing at the **backup**, deliberately
not at the primary. An earlier version pointed it at the same interface mwan3
was steering to, so every lookup returned the same device and "mwan3 overrode
pbr" and "pbr survived" were the same answer: the checks passed no matter what
the code did. There is now an explicit guard that fails the group if the fixture
cannot discriminate, rather than letting it report success.

**Every group stands up its own mwan3 state.** They used to inherit whatever the
previous group left, which is why this suite once passed group-by-group and
failed as a whole run. If you add a group, do not assume mwan3 is running, and
poll with `wait_armed` rather than sleeping a fixed number of seconds.

**`generator-suite.js` is the other half of the ownership contract.** It loads
the real `generator.js` under Node through `tests/luci-module.js` and runs
`audit()` against the same config shapes `ownership-suite.sh` drives through
the init script, written in the same `uci show mwan3` notation so the two
halves are described once rather than twice. Describing them twice, in two
notations, is how they stopped agreeing in the first place. It also feeds
`desired()`'s own output back through `audit()`, because a generator that
writes configuration its own classifier then calls foreign is a deadlock the
user cannot escape from the UI.

The two shell suites drive the installed init script and observe what it does
to the mwan3 service. **Neither reimplements the ownership arithmetic, and
that is not a style preference.** An earlier version of the hardware suite kept
its own copy of that logic and asserted on the copy; every one of those checks
passed against a known-broken reconciler, because the copy was correct when the
shipped code was not. `generator-suite.js` follows the same rule on its side:
it loads the shipped module and calls it, and copies nothing out of it.

`ownership-suite.sh` exists because the ownership rule is implemented twice,
in the browser and in the init script, and a rule implemented twice drifts. It
has drifted three times, and every time the drift pointed at tearing down
mwan3 configuration this package did not write. Its fixtures are chosen for
where the two halves *could* read a config differently, not for what a user is
likely to have.

The two shell suites restore `/etc/config/mwan3`, `/etc/config/wansentry` and
the mwan3 init script on exit, including on interrupt and on a dropped SSH
session, and both take an exclusive lock against each other and against the
sibling package's suites. `generator-suite.js` touches nothing outside its own
process and can be run any time, including in CI, which it is.

**If you add a check, write the sabotage first, then actually run it.** Writing
the sabotage comment is not the same as performing the sabotage, and the
difference is not academic: in the 2026-08-27 round, running the sabotages found
two checks that could not fail at all. One compared a fixture against itself and
would have passed with the code it was testing deleted; the other was the check
meant to catch non-determinism, and it was itself deterministic either way.
Both read perfectly well. Copy the package to a scratch directory, apply the
edit the comment names, and confirm the expected check goes red and nothing
else does.

**Be careful with hand-off cases specifically.** A correct hand-off makes no service calls, so its evidence
log is empty, so "it did not tear anything down" is equally satisfied by a
reconciler that never ran. Every hand-off check here proves the reconciler ran
by a separate route before asserting what it did not do. That defect has been
in this file twice.

## Code style

Match the surrounding code:

- `generator.js` is deliberately DOM-free. It is the part worth reasoning
  about in isolation, and it should stay testable as a pure function from
  settings to desired mwan3 sections. Keep DOM work in `overview.js`.
- No bundler, no framework, no charting library. LuCI's own `form`, `ui`,
  `rpc`, `poll` and `dom` modules only.
- Nothing in this package runs a shell, with one deliberate exception
  (`logread` for the event list, which has no ubus equivalent). Please keep it
  that way.
- SPDX headers on new files, Apache-2.0.

## Commits

Prefix the subject with the package name, lowercase after the colon:

    luci-app-wansentry: widen the probe-host column on narrow screens

If you would like the change to be portable upstream to `openwrt/luci` later,
add a `Signed-off-by:` line with your real name, which is what upstream's DCO
requires.

## Translations

The string catalogue lives in `po/templates/wansentry.pot`. It is generated
from the source, not written by hand: every `_('...')` call in
`htdocs/luci-static/resources/view/wansentry/*.js`, plus the `title` and
`description` values in `root/usr/share/luci/menu.d/*.json` and
`root/usr/share/rpcd/acl.d/*.json`. That file selection and those keywords are
LuCI's, from `build/i18n-scan.pl` in the `openwrt/luci` tree.

To add a language, create `po/<lang>/wansentry.po` from the template and
translate the `msgstr` lines. **Nothing in `Makefile` needs to change.**
`luci.mk` discovers languages by globbing `po/*` and generates a
`luci-i18n-wansentry-<lang>` package for each, so a new directory is the whole
of the work. The one-package-per-language split is deliberate upstream policy;
a combined "all languages" package [was proposed and
rejected](https://github.com/openwrt/luci/issues/4075).

**Take particular care with the failure and hand-off strings.** This package's
screen has to explain when it is *refusing* to act, and a translation that
softens "applying is refused" into something closer to "applying may not work"
turns a definite statement into an ambiguous one at the moment the reader most
needs a definite one. If a phrase does not translate cleanly, say so in the PR
rather than guessing; a comment is more useful than a smooth wrong sentence.

Keep the `%s` and `%d` specifiers and their order intact.

## Where help is most useful

**A live failover under load.** Everything else about this package has been
verified on hardware: config generation, idempotent rewrite, the ownership
refusal, rollback, and service reconciliation. The one thing that has not been
tested is the event the package exists to handle, because the development
bench had only one real uplink. If you run wansentry with two genuinely live
uplinks and pull the primary while traffic is flowing, a report of what
happened is the single most valuable contribution available right now,
patch or no patch.

Worth including: whether the switchover happened, roughly how long it took,
whether existing connections recovered or hung, and whether conntrack
flushing behaved as expected.
