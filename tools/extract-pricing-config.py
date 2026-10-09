#!/usr/bin/env python3
"""
ดึงค่าตั้งราคาจาก "Punch คำนวนราคา.xlsx" → private/pricing-config.json และ private/pricing-fixtures.json

- ไฟล์นี้มีเฉพาะ "ตำแหน่งช่อง" ใน Excel ไม่มีตัวเลขต้นทุน/ตัวคูณ (repo เป็นสาธารณะ)
- ผลลัพธ์อยู่ใน private/ ซึ่งถูก .gitignore ไว้ ห้าม commit
- fixtures คำนวณโดย "รันสูตร Excel จริง" ซ้ำที่ขนาดต่าง ๆ เพื่อใช้ทดสอบ api/_lib/pricing.js

ใช้งาน:  python3 -I tools/extract-pricing-config.py "/path/to/Punch คำนวนราคา.xlsx"
"""
import json, re, sys, zipfile, datetime, os, math
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}

# ---------- ตำแหน่งช่องของแต่ละสูตร (ไม่มีตัวเลขราคา) ----------
BOARD = "board"
VINYL = "vinyl"
RULES = {
    "plaswood_1layer": dict(sheet="คำนวนราคาพลาสวูดเกรดB_5มิล", formula=BOARD, w="C5", h="D5",
        costPerCm2="A3", variableCost="P5", fixedCost="Q5", multiplier="W3", shipping="V5", vatRate="X3",
        addons=["X6", "X7", "X8", "X9"], addonLabelCol="V", total="Z9"),
    "plaswood_2layer": dict(sheet="คำนวนราคาพลาสวูดเกรดB_5มิล", formula=BOARD, w="C19", h="D19",
        costPerCm2="A17", variableCost="P19", fixedCost="Q19", multiplier="W17", shipping="V19", vatRate="X17",
        addons=["X20", "X21", "X22", "X23", "X24"], addonLabelCol="V", total="Z24"),
    "plaswood_diecut_lit": dict(sheet="คำณวนพลาสวุดไดคัทตัวอักษร +ไฟออ", formula=BOARD, w="C5", h="D5",
        costPerCm2="A3", variableCost="L5", fixedCost="M5", multiplier="S3", shipping="R5", vatRate="T3",
        addons=["T7", "T8", "T9"], addonLabelCol="R", total="V9"),
    "plaswood_cutout": dict(sheet="คำณวนพลาสวุดฉลุลาย", formula=BOARD, w="C5", h="D5",
        costPerCm2="A3", variableCost="L5", fixedCost="M5", multiplier="S3", shipping="R5", vatRate="T3",
        addons=["T7", "T8", "T9"], addonLabelCol="R", total="V11"),
    "plaswood_acrylic_lit": dict(sheet="คำณวนพลาสวุด+อะคิลิค +ไฟ +ไม่ไฟ", formula=BOARD, w="C5", h="D5",
        costPerCm2="A3", variableCost="L5", fixedCost="M5", multiplier="S3", shipping="R5", vatRate="T3",
        addons=["T6", "T7", "T8", "T9", "T10"], addonLabelCol="R", total="V12"),
    "composite": dict(sheet="คำณวนราคาคอมโพสิท+วาณิช", formula=BOARD, w="C5", h="D5",
        costPerCm2="A3", variableCost="L5", fixedCost="M5", multiplier="S3", shipping="R5", vatRate="T3",
        addons=["T6", "T7", "T8"], addonLabelCol="R", total="V10"),
    "vinyl": dict(sheet="คำนวนราคาไวนิล", formula=VINYL, w="C5", h="D5",
        materialPerM2="G5", variableCost="H5", fixedCost="I5", multiplier="O3", shipping="N5", vatRate="P3",
        addons=["P6", "P7", "P8", "P9"], addonLabelCol="N", total="R12"),
}
# งานติดไฟ: โน้ตใน Excel ระบุ "เกิน 5 เมตร + เพิ่ม 1500" ซึ่งยังไม่ชัด → เกินขนาดนี้ให้ทีมงานประเมิน
REVIEW_IF_MAX_DIM_ABOVE = {"plaswood_diecut_lit": 500, "plaswood_acrylic_lit": 500}
TEST_SIZES = [(30, 40), (60, 90), (120, 120), (120, 240), (200, 400)]


# ---------- อ่าน xlsx ----------
def load_workbook(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            ss.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for s in wb.find("m:sheets", NS):
        target = rels[s.get("{%s}id" % NS["r"])].lstrip("/")
        path_in_zip = target if target.startswith("xl/") else "xl/" + target
        root = ET.fromstring(z.read(path_in_zip))
        cells, shared = {}, {}
        for c in root.iter("{%s}c" % NS["m"]):
            ref, t = c.get("r"), c.get("t")
            v, f = c.find("m:v", NS), c.find("m:f", NS)
            val = v.text if v is not None else None
            if t == "s" and val is not None:
                val = ss[int(val)]
            elif t not in ("s", "str", "inlineStr") and val is not None:
                val = float(val)
            formula = None
            if f is not None:
                if f.get("t") == "shared":
                    si = f.get("si")
                    if f.text:
                        shared[si] = (ref, f.text)
                        formula = f.text
                    else:
                        formula = ("shared", si)
                elif f.text:
                    formula = f.text
            cells[ref] = {"v": val, "f": formula}
        for ref, cell in cells.items():
            if isinstance(cell["f"], tuple):
                base_ref, base_f = shared[cell["f"][1]]
                cell["f"] = shift_formula(base_f, base_ref, ref)
        sheets[s.get("name")] = cells
    return sheets


def split_ref(ref):
    m = re.match(r"\$?([A-Z]+)\$?(\d+)$", ref)
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return col, int(m.group(2))


def col_name(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def shift_formula(formula, base_ref, ref):
    bc, br = split_ref(base_ref)
    c, r = split_ref(ref)
    dc, dr = c - bc, r - br

    def repl(m):
        cabs, cname, rabs, row = m.groups()
        cc, _ = split_ref(cname + "1")
        new_c = cname if cabs else col_name(cc + dc)
        new_r = row if rabs else str(int(row) + dr)
        return f"{cabs}{new_c}{rabs}{new_r}"
    return re.sub(r"(\$?)([A-Z]+)(\$?)(\d+)", repl, formula)


# ---------- ตัวคำนวณสูตร Excel ขนาดเล็ก (+ - * / ( ) SUM CEILING) ----------
TOKEN = re.compile(r"\s*(\d+\.?\d*(?:E[+-]?\d+)?|\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?|[A-Z]+(?=\()|[-+*/(),])")


class Evaluator:
    def __init__(self, cells, overrides):
        self.cells, self.overrides, self.cache = cells, overrides, {}

    def value(self, ref):
        ref = ref.replace("$", "")
        if ref in self.overrides:
            return float(self.overrides[ref])
        if ref in self.cache:
            return self.cache[ref]
        cell = self.cells.get(ref)
        if cell is None:
            out = 0.0
        elif cell["f"]:
            out = self.eval(cell["f"])
        else:
            v = cell["v"]
            if v is None:
                out = 0.0
            elif isinstance(v, str):
                try:
                    out = float(v)  # Excel ยอมแปลงข้อความตัวเลข เช่น "4.5"
                except ValueError:
                    out = 0.0
            else:
                out = v
        self.cache[ref] = out
        return out

    def range_values(self, rng):
        a, b = rng.replace("$", "").split(":")
        c1, r1 = split_ref(a)
        c2, r2 = split_ref(b)
        return [self.value(f"{col_name(c)}{r}") for c in range(c1, c2 + 1) for r in range(r1, r2 + 1)]

    def eval(self, formula):
        saved = getattr(self, "toks", None), getattr(self, "i", 0)  # สูตรซ้อนสูตร
        self.toks = [t for t in TOKEN.findall(formula) if t]
        self.i = 0
        out = self.expr()
        if self.i != len(self.toks):
            raise ValueError(f"unparsed formula: {formula}")
        self.toks, self.i = saved
        return out

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def expr(self):
        v = self.term()
        while self.peek() in ("+", "-"):
            v = v + self.term() if self.take() == "+" else v - self.term()
        return v

    def term(self):
        v = self.factor()
        while self.peek() in ("*", "/"):
            v = v * self.factor() if self.take() == "*" else v / self.factor()
        return v

    def args(self):
        self.take()  # (
        items = []
        while self.peek() != ")":
            t = self.peek()
            if ":" in (t or ""):
                items.extend(self.range_values(self.take()))
            else:
                items.append(self.expr())
            if self.peek() == ",":
                self.take()
        self.take()  # )
        return items

    def factor(self):
        t = self.take()
        if t == "-":
            return -self.factor()
        if t == "+":
            return self.factor()
        if t == "(":
            v = self.expr()
            self.take()
            return v
        if t == "SUM":
            return sum(self.args())
        if t == "CEILING":
            x, sig = self.args()
            return math.ceil(x / sig - 1e-12) * sig
        if re.match(r"\d", t):
            return float(t)
        return self.value(t)


# ---------- main ----------
def num(cells, ref):
    v = cells.get(ref, {}).get("v")
    if v is None or v == "":
        return 0.0
    return float(v)


def main(xlsx):
    sheets = load_workbook(xlsx)
    previous = {}
    if os.path.exists("private/pricing-config.json"):  # เก็บสถานะที่เจ้าของร้านยืนยันไว้แล้ว
        with open("private/pricing-config.json", encoding="utf-8") as f:
            previous = json.load(f).get("rules", {})
    config = {"source": os.path.basename(xlsx),
              "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
              "note": "สร้างโดย tools/extract-pricing-config.py — ข้อมูลลับ ห้าม commit",
              "rules": {}}
    fixtures, problems = [], []

    for rid, spec in RULES.items():
        cells = sheets[spec["sheet"]]
        rule = {"enabled": False, "formula": spec["formula"], "sheet": spec["sheet"],
                "variableCost": num(cells, spec["variableCost"]), "fixedCost": num(cells, spec["fixedCost"]),
                "multiplier": num(cells, spec["multiplier"]), "shipping": num(cells, spec["shipping"]),
                "vatRate": num(cells, spec["vatRate"]), "addons": []}
        if spec["formula"] == BOARD:
            rule["costPerCm2"] = num(cells, spec["costPerCm2"])
        else:
            rule["materialPerM2"] = num(cells, spec["materialPerM2"])
        for ref in spec["addons"]:
            v = cells.get(ref, {}).get("v")
            if isinstance(v, float) and v:
                row = re.sub(r"[A-Z]+", "", ref)
                label = cells.get(spec["addonLabelCol"] + row, {}).get("v") or "(ไม่มีชื่อรายการ)"
                rule["addons"].append({"label": str(label).strip(), "amount": v})
        rule["reviewIfMaxDimAbove"] = REVIEW_IF_MAX_DIM_ABOVE.get(rid)
        if rid in previous:
            rule["enabled"] = previous[rid].get("enabled") is True
            rule["reviewIfMaxDimAbove"] = previous[rid].get("reviewIfMaxDimAbove", rule["reviewIfMaxDimAbove"])
        config["rules"][rid] = rule

        # 1) ค่าที่ Excel คำนวณเก็บไว้ (cached) ต้องตรงกับการรันสูตรซ้ำ
        w, h = num(cells, spec["w"]), num(cells, spec["h"])
        cached = num(cells, spec["total"])
        recomputed = Evaluator(cells, {}).value(spec["total"])
        if abs(cached - recomputed) > 1e-6:
            problems.append(f"{rid}: evaluator {recomputed} != cached {cached}")
        fixtures.append({"rule": rid, "widthCm": w, "heightCm": h, "expected": cached, "source": "excel-cached"})

        # 2) รันสูตร Excel จริงที่ขนาดอื่น
        for tw, th in TEST_SIZES:
            v = Evaluator(cells, {spec["w"]: tw, spec["h"]: th}).value(spec["total"])
            fixtures.append({"rule": rid, "widthCm": tw, "heightCm": th, "expected": v, "source": "excel-formula"})

    os.makedirs("private", exist_ok=True)
    with open("private/pricing-config.json", "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    with open("private/pricing-fixtures.json", "w", encoding="utf-8") as f:
        json.dump(fixtures, f, ensure_ascii=False, indent=2)
    print(f"rules: {len(config['rules'])}, fixtures: {len(fixtures)}")
    print("evaluator self-check:", "OK" if not problems else problems)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
