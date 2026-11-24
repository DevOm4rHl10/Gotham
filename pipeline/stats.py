"""Hotspot statistics on the hex grid: Getis-Ord Gi*, FDR control, zones."""
import math

import numpy as np

from .grid import NEIGHBOURS, key, unkey


def _lookup(sorted_keys, wanted):
    """Index of each wanted key in sorted_keys, or -1 if absent."""
    idx = np.searchsorted(sorted_keys, wanted)
    idx = np.clip(idx, 0, len(sorted_keys) - 1)
    return np.where(sorted_keys[idx] == wanted, idx, -1)


def gi_star(q, r, values):
    """Getis-Ord Gi* z-scores with binary weights over each cell + its 6 neighbours.

    Gi* needs the zero cells too, otherwise the mean is computed over
    crime-only cells and nothing looks unusual. We add a one-cell ring of
    zeros around every observed cell; cells further out (sea, moorland) are
    left out of the study area.

    Returns (q, r, values, z, observed) for the padded study area.
    """
    base = key(q, r)
    ring = np.concatenate([key(q + dq, r + dr) for dq, dr in NEIGHBOURS])
    all_keys = np.unique(np.concatenate([base, ring]))
    x = np.zeros(len(all_keys))
    x[np.searchsorted(all_keys, base)] = values
    observed = np.zeros(len(all_keys), dtype=bool)
    observed[np.searchsorted(all_keys, base)] = True

    aq, ar = unkey(all_keys)
    local = x.copy()
    w = np.ones(len(all_keys))
    for dq, dr in NEIGHBOURS:
        j = _lookup(all_keys, key(aq + dq, ar + dr))
        hit = j >= 0
        local[hit] += x[j[hit]]
        w[hit] += 1

    n = len(x)
    mean = x.mean()
    s = math.sqrt(max((x ** 2).mean() - mean ** 2, 1e-12))
    denom = s * np.sqrt(np.maximum((n * w - w ** 2) / (n - 1), 1e-12))
    z = (local - mean * w) / denom
    return aq, ar, x, z, observed


def hot_significant(z, fdr):
    """One-sided Benjamini-Hochberg: True where a cell is a hotspot at the given FDR."""
    p = 0.5 * np.vectorize(math.erfc)(z / math.sqrt(2.0))
    order = np.argsort(p)
    ranked = p[order] * len(p) / np.arange(1, len(p) + 1)
    qvals = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.zeros(len(p), dtype=bool)
    out[order] = qvals <= fdr
    return out & (z > 0)


def components(q, r):
    """Connected groups of hex cells (6-neighbour). Returns a label per cell."""
    keys = key(q, r)
    order = np.argsort(keys)
    sorted_keys = keys[order]
    labels = np.full(len(keys), -1, dtype=np.int64)
    current = 0
    for start in range(len(keys)):
        if labels[start] >= 0:
            continue
        labels[start] = current
        stack = [start]
        while stack:
            i = stack.pop()
            for dq, dr in NEIGHBOURS:
                j = _lookup(sorted_keys, key(q[i] + dq, r[i] + dr))
                if j >= 0:
                    j = order[j]
                    if labels[j] < 0:
                        labels[j] = current
                        stack.append(j)
        current += 1
    return labels


def split_zones(q, r, score, max_cells):
    """Connected components, recursively splitting any larger than max_cells.

    A big city can produce one huge connected blob of significant cells,
    which is true but useless as "a hotspot". For such blobs we keep only
    cells above the blob's median score and re-split, which peels away the
    fringe and separates distinct cores. Returns a zone label per cell, or
    -1 for fringe cells that were peeled off.
    """
    labels = np.full(len(q), -1, dtype=np.int64)
    next_id = 0
    queue = [np.arange(len(q))]
    while queue:
        idx = queue.pop()
        comp = components(q[idx], r[idx])
        for c in np.unique(comp):
            members = idx[comp == c]
            if len(members) <= max_cells:
                labels[members] = next_id
                next_id += 1
            else:
                core = members[score[members] > np.median(score[members])]
                if len(core):
                    queue.append(core)
    return labels


def jaccard(a, b):
    a, b = set(a), set(b)
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)
