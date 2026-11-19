#!/usr/bin/env python3
"""Attribute V8 --prof ticks that fall inside the powerboat binary to its symbols.

node's tick processor cannot symbolize an aarch64 binary on the PC; this does it from an
`nm -n --defined-only -C` listing of the unstripped binary (cargo's target dir; the dist copy is
stripped). Usage:
    v8_ticks_by_symbol.py <v8.log> <nm listing> [binary path in the log] [top N] [start_ms,end_ms]
Prints the top symbols by tick count with the V8 VM state mix (JS/GC/EXTERNAL/...).
"""
import bisect
import collections
import sys

STATES = {0: "JS", 1: "GC", 2: "PARSER", 3: "BYTECODE", 4: "COMPILER", 5: "OTHER", 6: "EXTERNAL", 7: "ATOMICS", 8: "IDLE", 9: "LOGGING"}


def main():
    log, nm = sys.argv[1], sys.argv[2]
    binary = sys.argv[3] if len(sys.argv) > 3 else "/tmp/powerboat-m0/powerboat"
    top = int(sys.argv[4]) if len(sys.argv) > 4 else 40
    # optional time window in ms of the log clock: argv[5] = "start,end"
    t0, t1 = (float(x) * 1000 for x in sys.argv[5].split(",")) if len(sys.argv) > 5 else (0, float("inf"))
    addrs, names = [], []
    with open(nm, encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\n").split(" ", 2)
            if len(parts) < 3 or parts[1] not in "tTwW":
                continue
            try:
                addrs.append(int(parts[0], 16))
            except ValueError:
                continue
            names.append(parts[2])
    base = None
    counts = collections.Counter()
    states = collections.defaultdict(collections.Counter)
    total = inside = 0
    with open(log, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("shared-library,") and base is None:
                p = line.split(",")
                if p[1] == binary:
                    base = int(p[2], 16)
            elif line.startswith("tick,"):
                p = line.split(",")
                if not (t0 <= int(p[2]) <= t1):
                    continue
                total += 1
                pc = int(p[1], 16)
                state = STATES.get(int(p[5]), p[5]) if len(p) > 5 and p[5].strip().isdigit() else "?"
                if base is None or pc < base:
                    continue
                off = pc - base
                i = bisect.bisect_right(addrs, off) - 1
                if i < 0:
                    continue
                inside += 1
                counts[names[i]] += 1
                states[names[i]][state] += 1
    print(f"{total} ticks, {inside} inside {binary} ({100.0 * inside / max(1, total):.1f}%)")
    for name, n in counts.most_common(top):
        mix = " ".join(f"{s}:{c}" for s, c in states[name].most_common(3))
        print(f"{n:7d} {100.0 * n / total:5.1f}%  {name[:110]}  [{mix}]")


if __name__ == "__main__":
    main()
