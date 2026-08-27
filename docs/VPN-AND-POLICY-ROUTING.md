# Failover on a router that runs a VPN

If your router runs a VPN, or steers some traffic through one with `pbr`, then
adding failover changes things that are not obvious and whose failures are
quiet. This page is about those.

Most of it is not specific to wansentry. It applies to mwan3 however you drive
it, and several of the hazards apply to any failover setup at all. Where a
number appears it was measured, on OpenWrt 25.12.5 with mwan3 2.12.0-r3,
pbr 1.2.2-r20 and openvpn-openssl 2.7.6, on 27 August 2026. Where something was
not measured, this page says so rather than rounding it up to a claim.

**Do not take the numbers on trust.** Section 7 is a set of commands that
measure your own router, and it is the most useful part of this page.

---

## 1. The four layers, and who decides what

A router with an uplink, a backup and a tunnel has four things making routing
decisions, and they do not know about each other:

| layer | decides | example |
|---|---|---|
| netifd | which interfaces exist and their routes | `wan`, `wwan`, `vpnusa` |
| mwan3 | which **uplink** traffic leaves by | primary is down, use the backup |
| pbr | which traffic **enters the tunnel** | this subnet exits in another country |
| the VPN client | how to reach its own server | UDP to a public endpoint |

The mental model that keeps this straight:

> **pbr decides what goes into the tunnel. mwan3 decides which uplink the
> tunnel itself rides on.**

Those are different questions and both need an answer. Most confusion here comes
from asking one layer to answer the other's question.

A tunnel is **not** an uplink. It runs over one. Failing over *to* a VPN is
meaningless: if the uplink beneath it is down, so is the tunnel. wansentry
classifies tunnel interfaces and does not offer them as primary or backup for
this reason, and says so on screen rather than hiding them.

---

## 2. mwan3 silently overrides pbr

This is the one to read even if you skip the rest.

Both mwan3 and pbr mark packets and install `ip rule` entries. The obvious worry
is that their fwmarks collide. **They do not:**

```
pbr    masks on 0x00ff0000    ip rules at priority 29995-30000
mwan3  masks on 0x00003f00    ip rules at priority  1001-3002
```

The bit ranges are disjoint, so both marks sit on the same packet without either
corrupting the other. What collides is the **rule priority**. Rules are
evaluated in ascending order, so mwan3's tables are consulted roughly 28,000
priorities before pbr's, and pbr's decision never runs.

Measured with a real FIB lookup:

```
mark 0x050000   pbr policy only     ->  dev tun0   table pbr_vpnusa
mark 0x000100   mwan3 uplink only   ->  dev wan    table 1
mark 0x050100   both marks set      ->  dev wan    table 1      <- pbr lost
```

and confirmed with real forwarded traffic, reading the conntrack reply tuple to
see which uplink actually performed the source translation:

```
without exclusions   a client inside a pbr policy range  ->  plain WAN
with exclusions      the same client                     ->  the tunnel
```

### Why this is worse than an ordinary bug

Nothing breaks. Traffic keeps flowing. Both packages report success. Neither
logs anything. Your traffic simply stops going where you sent it.

If you use pbr for a country exit, the affected devices quietly begin appearing
in the wrong country, and the first sign is usually a streaming service
behaving oddly weeks later. A failure that presents as success gets found late.

### The fix, and what wansentry does about it

For every source or destination range an enabled pbr policy claims, wansentry
generates an mwan3 rule carrying `use_policy 'default'`, ordered ahead of the
catch-all:

```
config rule 'wansentry_pbr1'
	option src_ip '192.168.72.128/25'
	option use_policy 'default'
	option family 'ipv4'
	option wansentry '1'
```

`default` is mwan3's own escape hatch. It stamps only mwan3's no-op mark, which
matches none of mwan3's own ip rules, so evaluation falls through to pbr's and
the policy survives. Traffic outside pbr's ranges is untouched and still fails
over normally.

**Order matters and is easy to get wrong by hand.** mwan3 stops at the first
matching rule, so an exclusion sitting behind the catch-all can never fire, and
`uci add` appends. If you write these yourself, put them first and check with
`mwan3 rules`.

**A policy that matches on neither a source nor a destination claims
everything.** An mwan3 rule mirroring it would match every packet on the router,
including the tunnel's own outer packets, and switch failover off while
appearing to configure it. wansentry refuses those and names them on screen
rather than approximating.

### This rests on someone else's numbers

Those priorities belong to mwan3 and pbr, not to wansentry. A release that
renumbers them would invalidate the mechanism **silently**: the generated config
would still look right and still apply cleanly. `tests/hardware-suite.sh pbr`
asserts the premise directly for that reason. If you are debugging something
strange, check it yourself with `ip -4 rule show`.

---

## 3. DNS is the most likely reason a working failover looks broken

This has nothing to do with your VPN and everything to do with how a switchover
feels from the sofa.

dnsmasq merges the resolvers it learned from **every interface that is up** into
one runtime file, and picks between them with no regard to failover state. After
a switchover it can keep sending queries out the uplink that just died. Routing
is correct, the internet is reachable, and nothing resolves.

The symptom is the worst possible one: the failover worked, the dashboard is
green, and the network is unusable. People then spend an hour looking at
routing.

mwan3 does not solve this, and wansentry does not pretend to. Pin your upstream
resolvers instead:

```
uci set dhcp.@dnsmasq[0].noresolv='1'
uci add_list dhcp.@dnsmasq[0].server='1.1.1.1'
uci add_list dhcp.@dnsmasq[0].server='8.8.8.8'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

`noresolv 1` stops dnsmasq reading the merged file at all; the `server` lines
give it fixed upstreams reachable from whichever uplink is live. Names on your
own LAN keep working, because dnsmasq answers those itself from its leases.

To undo:

```
uci delete dhcp.@dnsmasq[0].noresolv
uci delete dhcp.@dnsmasq[0].server
uci commit dhcp
/etc/init.d/dnsmasq restart
```

**Worth knowing if you run a country exit.** Your router resolves over its own
uplink, not through the tunnel, so DNS is already answered from wherever the
router is, regardless of which devices you steer into the VPN. Pinning
resolvers does not change that and does not fix it. If geo-restricted content
misbehaves while the tunnel is plainly working, that is where to look. Sending
DNS through the tunnel is a separate exercise and out of scope here.

---

## 4. Does your tunnel survive a switchover?

Probably, if it is modern. Measure rather than assume.

Measured on OpenVPN 2.7 against a server that negotiates `peer-id`, over two
failure modes, sampling the whole stack once per second for 200 seconds:

| failure mode | samples | lost | outage | tunnel restarted? |
|---|---|---|---|---|
| link gone (`ifdown wan`) | 101 | 0 | none measurable | no |
| upstream dead, link still up | 98 | 5 | about 10 s | no |

In both cases the OpenVPN process kept its PID and logged nothing at all. The
reason is in the handshake:

```
peer-id: 0
protocol-flags cc-exit tls-ekm dyn-tls-crypt
```

OpenVPN 2.7 identifies a session by peer-id rather than by the client's source
address, so a `nobind` client roams onto the new uplink's address mid-session
without renegotiating. `ping-restart` never fires because nothing ever restarts.

**The residual ten seconds is mwan3's own detection time**, `interval` x
`down`, not the tunnel's. It is tunable by your failover settings and by nothing
else.

### Check your own tunnel

The pushed options are logged at connect time, at verbosity 3 or above. Most
OpenWrt clients ship at `verb 1`, where the line does not appear. Raise it,
bounce once, read, put it back:

```
uci set openvpn.<yourclient>.verb='3'
uci commit openvpn
/etc/init.d/openvpn restart
sleep 15
logread | grep -i "PUSH.*Received control message"
logread | grep -iE "Timers:|peer-id"
uci set openvpn.<yourclient>.verb='1'
uci commit openvpn
```

A real reply looks like this:

```
PUSH_REPLY, redirect-gateway def1 bypass-dhcp, route-gateway 10.x.x.1,
topology subnet, ping 10, ping-restart 120, ifconfig 10.x.x.2 255.255.255.0,
peer-id 0, cipher AES-256-GCM, protocol-flags cc-exit tls-ekm dyn-tls-crypt
```

**If you see `peer-id`,** your client can migrate and a switchover should cost
you only mwan3's detection time.

**If you do not,** the client's source address is part of its identity to the
server. Moving to a different uplink changes it, the server drops the packets,
and you wait for `ping-restart` before anything recovers. On a default
`ping-restart 120` that is up to two minutes of a tunnel that looks up and
carries nothing. In that case, either shorten the fallback:

```
uci set openvpn.<yourclient>.keepalive='10 30'
```

or bounce the tunnel yourself on a switchover with a hook (section 6).

**WireGuard is a separate question and is not measured here.** It re-handshakes
on its own and is generally expected to recover within seconds, but this page
will not claim a number it did not take.

### Mind the blast radius when you bounce it

If you use pbr with `strict_enforcement '1'`, everything that policy claims is
**blocked** while the tunnel is down, not merely slower. Bouncing a tunnel to
read a log line takes part of your LAN offline for the duration. Short, but pick
your moment.

---

## 5. Two settings that look like tidy-ups and are not

### `route_nopull`

Many VPN providers push `redirect-gateway def1`, which tells the client to send
**all** traffic through the tunnel. If you are using pbr to steer only some
traffic, `route_nopull '1'` on the client is the only thing discarding that
instruction.

This is live on every connect, not dormant. Verified in a real `PUSH_REPLY`
above: the redirect is right there in the push, and the client silently throws
it away. Remove `route_nopull`, or forget it when cloning a client config, and
your entire household exits through the VPN while every pbr policy becomes
irrelevant.

It reads like a housekeeping option. It is load-bearing. Say so somewhere your
future self will look, because `uci` strips `#` comments from
`/etc/config/openvpn` the first time anything edits the file.

### `strict_enforcement`

With `strict_enforcement '1'`, pbr writes an `unreachable` default into the
routing table of any interface that is unavailable:

```
unreachable default table pbr_wanb
```

So a policy whose interface is down **refuses** traffic instead of quietly
rerouting it. That looks harsh and it is the safer behaviour. Without it, that
traffic falls through to the main table and leaves by whatever uplink is up,
which for a policy pinned to a local-only destination means chasing an RFC1918
address out over a cellular link.

**Do not turn this off to make a failover look smoother.** It is what stops your
country-exit traffic silently leaving from the wrong country while the tunnel is
rebuilding.

---

## 6. When you do need something to happen on a switchover

wansentry runs every executable in `/etc/wansentry.d/` when the active uplink
changes, and at nothing else. Each hook gets `WANSENTRY_OLD`, `WANSENTRY_NEW`
and `WANSENTRY_EVENT`, runs as root, and is logged and ignored if it fails so a
broken hook cannot stall the rest of a switchover. Repeated events that do not
change the active uplink run nothing, and a flapping primary is debounced.

```
cat > /etc/wansentry.d/10-bounce-tunnel <<'EOF'
#!/bin/sh
[ "$WANSENTRY_NEW" = "none" ] && exit 0
/etc/init.d/openvpn restart
EOF
chmod +x /etc/wansentry.d/10-bounce-tunnel
```

**Check whether you need it before you write it.** The obvious use, restarting a
VPN so it follows the failover, turned out to be unnecessary for OpenVPN 2.7 and
would have been a disruption fixing a problem that does not occur. Measure your
own tunnel with section 4 first.

There is deliberately no "run this command on switchover" field in the web
interface. That would be remote command execution handed to whoever holds the
failover ACL, and a dropdown of every init script on the box is the same thing
wearing a hat. Writing to `/etc/wansentry.d/` already requires root, so the
directory grants nothing you did not already have.

---

## 7. Measure your own router

None of the above is worth trusting on someone else's hardware. These commands
answer the questions on yours.

**Which subsystems are installing routing rules, and in what order:**

```
ip -4 rule show
```

Lower priority numbers win. If pbr's rules sit at higher numbers than mwan3's,
section 2 applies to you.

**Whether the exclusions were generated:**

```
mwan3 rules
```

Anything wansentry generated for pbr appears first, before the catch-all.

**Where a packet would actually go, without sending one.** Take a mark from
`ip -4 rule show` and ask the kernel:

```
ip route get 1.1.1.1 mark 0x050000
```

Combine two marks with a bitwise OR to see which subsystem wins when both have
marked a packet. This is a real FIB lookup through the real rule chain, so it
cannot be fooled by a plausible-looking config.

**Where a client's traffic actually went.** This is the oracle that settles
arguments, because it reports what the kernel did rather than what it intended.
Generate some traffic from a LAN client, then:

```
grep 'src=192.168.1.200 dst=1.1.1.1' /proc/net/nf_conntrack |
  awk '{for(i=1;i<=NF;i++) if($i ~ /^dst=/) d=$i} END{print d}'
```

The **second** `dst=` in the line is the reply tuple's destination, which is the
address your router translated to. That names the uplink the packet left by. If
it is your tunnel's address, the policy worked. If it is your WAN address, it
did not.

**Whether the tunnel survived, rather than whether it looks up.** `ifstatus`
will happily report a tunnel as up while it carries nothing. Ping the far end
instead:

```
ping -c3 -I tun0 <the other end of your tunnel>
```

---

## 8. What is not covered here

Stated plainly so silence is not mistaken for coverage.

- **WireGuard across a switchover.** Expected to re-handshake in seconds. Not
  measured.
- **OpenVPN 2.4 and 2.5**, and any server that does not negotiate `peer-id`.
- **pbr with `strict_enforcement '0'`**, where a policy whose interface is down
  falls through to the main table instead of refusing.
- **IPv6 throughout.** wansentry generates IPv4 policy only, and the reference
  setup ran pbr with `ipv6_enabled '0'`. On a dual-stack network IPv6 traffic is
  unaffected by a failover and keeps using the failed uplink's route until that
  route goes away.
- **Failing over between two VPNs**, as opposed to failing over the uplink
  underneath one.
- **Policy routing packages other than pbr.** The mechanism generalises, the
  detection does not: wansentry reads pbr's configuration specifically.

If you measure any of these, the commands in section 7 are the ones that
produced the numbers on this page, and a report against them is worth more than
an opinion.
