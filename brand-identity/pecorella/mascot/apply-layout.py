#!/usr/bin/env python3
"""Applica layout.json (salvato dall'editor) a pecorella.svg.

Ogni pezzo corretto viene avvolto in un <g id="<pezzo>-pos" transform="...">:
così i gruppi originali (#testa, #zampa-as, …) restano SENZA transform e le
animazioni CSS (che impostano transform via classe) continuano a funzionare.
Idempotente: ri-eseguirlo aggiorna i wrapper, e rimuove quelli non più nel layout.

Uso:  python3 apply-layout.py          (da questa cartella)
"""
import json
import os
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "pecorella.svg")
LAYOUT = os.path.join(HERE, "layout.json")
NS = "http://www.w3.org/2000/svg"

ET.register_namespace("", NS)

with open(LAYOUT) as f:
    layout = json.load(f)
parts = layout.get("parts", {})

parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
tree = ET.parse(SVG, parser=parser)
root = tree.getroot()


def parent_map():
    return {c: p for p in root.iter() for c in p}


def find_by_id(el_id):
    for el in root.iter():
        if el.get("id") == el_id:
            return el
    return None


# 1) togli i wrapper -pos non più presenti nel layout
pm = parent_map()
for el in list(root.iter()):
    eid = el.get("id") or ""
    if eid.endswith("-pos") and eid[:-4] not in parts:
        p = pm[el]
        idx = list(p).index(el)
        p.remove(el)
        for child in reversed(list(el)):
            p.insert(idx, child)
        pm = parent_map()

# 2) applica/aggiorna i wrapper per i pezzi nel layout
applied, missing = [], []
for pid, info in parts.items():
    el = find_by_id(pid)
    if el is None:
        missing.append(pid)
        continue
    pm = parent_map()
    p = pm[el]
    if (p.get("id") or "") == pid + "-pos":
        p.set("transform", info["transform"])
    else:
        wrapper = ET.Element(f"{{{NS}}}g", {"id": pid + "-pos", "transform": info["transform"]})
        idx = list(p).index(el)
        p.remove(el)
        wrapper.append(el)
        p.insert(idx, wrapper)
    applied.append(pid)

tree.write(SVG, encoding="unicode", xml_declaration=False)
print(f"Applicati: {', '.join(applied) or 'nessuno'}")
if missing:
    print(f"ATTENZIONE, id non trovati nell'SVG: {', '.join(missing)}")
print(f"SVG aggiornato: {SVG}")
