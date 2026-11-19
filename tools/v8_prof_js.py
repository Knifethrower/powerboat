#!/usr/bin/env python3
"""V8 --prof log, by JS function: self ticks per function, and which JS function called the builtins.

node's tick processor needs the binary; this only needs code-creation lines, so it works on a log pulled from
a handheld. A tick in a builtin (LoadIC_Megamorphic, ...) counts for that builtin and for its nearest JS caller.
    v8_prof_js.py <v8.log> [top N] [start_s,end_s] [builtin to break down, repeatable]
"""
import bisect
import collections
import sys


def main():
    log = sys.argv[1]
    top = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    t0, t1 = (float(x) * 1e6 for x in sys.argv[3].split(",")) if len(sys.argv) > 3 and sys.argv[3] != "-" else (0, float("inf"))
    focus = sys.argv[4:]
    code = {}          # start -> (size, name, kind, tier)
    starts = []
    dirty = True

    def add(start, size, name, kind, tier):
        nonlocal dirty
        code[start] = (size, name, kind, tier)
        dirty = True

    def find(pc):
        nonlocal starts, dirty
        if dirty:
            starts = sorted(code)
            dirty = False
        i = bisect.bisect_right(starts, pc) - 1
        if i < 0:
            return None
        s = starts[i]
        c = code[s]
        return c if pc < s + c[0] else None

    self_ticks = collections.Counter()
    tier_ticks = collections.Counter()
    builtin_ticks = collections.Counter()
    callers = collections.defaultdict(collections.Counter)
    states = collections.Counter()
    total = 0
    with open(log, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("code-creation,"):
                # code-creation,kind,kindNo,time,start,size,name[,sfi,tier]
                p = line.rstrip("\n").split(",")
                try:
                    start, size = int(p[4], 16), int(p[5], 0)
                except (ValueError, IndexError):
                    continue
                tier = p[8] if len(p) > 8 else ""
                add(start, size, p[6].strip('"'), p[1], tier)
            elif line.startswith("code-move,"):
                p = line.split(",")
                try:
                    a, b = int(p[1], 16), int(p[2], 16)
                except ValueError:
                    continue
                if a in code:
                    add(b, *code.pop(a))
            elif line.startswith("tick,"):
                p = line.rstrip("\n").split(",")
                ts = int(p[2])
                if not t0 <= ts <= t1:
                    continue
                total += 1
                states[p[5]] += 1
                pc = int(p[1], 16)
                c = find(pc)
                frames = [c]
                # the rest of the stack: absolute hex or +/- offsets from the previous entry
                prev = pc
                for e in p[6:]:
                    if not e or e == "overflow":
                        continue
                    try:
                        if e[0] in "+-":
                            prev += int(e, 16)
                        else:
                            prev = int(e, 16)
                    except ValueError:
                        continue
                    frames.append(find(prev))
                if c is None:
                    self_ticks["(not in JS or a builtin)"] += 1
                    continue
                is_js = lambda x: x is not None and x[2] in ("JS", "LazyCompile", "Eval", "Script", "Function")
                if is_js(c):
                    self_ticks[c[1]] += 1
                    tier_ticks[c[3]] += 1
                else:
                    self_ticks["[%s] %s" % (c[2], c[1])] += 1
                    builtin_ticks[c[1]] += 1
                    # A builtin with no frame of its own: the stack walk starts at its caller's caller. On x86 the
                    # tick's top of stack is the return address, so the real load site. arm64 logs have only the
                    # stack, so there "callers" means one level up from the site.
                    tos = find(int(p[4], 16)) if p[3] == "0" and p[4] not in ("0x0", "") else None
                    who = tos if is_js(tos) else next((x for x in frames[1:] if is_js(x)), None)
                    callers[c[1]][who[1] if who else "?"] += 1
    print("ticks", total, "vm states", dict(states))
    print("tiers", dict(tier_ticks))
    for name, n in self_ticks.most_common(top):
        print("%6d %5.1f%%  %s" % (n, n * 100 / total, name[:110]))
    for b in focus or [x for x, _ in builtin_ticks.most_common(4)]:
        print("--- callers of", b, builtin_ticks[b])
        for name, n in callers[b].most_common(25):
            print("%6d  %s" % (n, name[:110]))


main()
