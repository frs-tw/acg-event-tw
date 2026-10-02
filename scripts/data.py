"""資料維護工具：合併查詢結果、檢查資料、刪除過期活動、列出現有活動。

用法（在 ACG-Site 資料夾執行）：
  python scripts/data.py list [縣市代碼]      列出現有活動（給 subagent 當跳過清單）
  python scripts/data.py merge <結果.json>    合併 {"places":{...},"events":[...]}，重複的跳過
  python scripts/data.py validate             檢查格式、代碼對應、日期
  python scripts/data.py prune                刪除結束超過一個月的活動與沒人用的地點
  python scripts/data.py geocode              幫沒有座標的地點補 lat/lng（OpenStreetMap，免費）
  python scripts/data.py covered <縣市> <日期>  記錄這次 AI 查詢涵蓋到哪一天
"""
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
IGNORE = ["皮克斯"]  # 忽略清單：標題含這些字的活動一律不收


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name, obj):
    (DATA / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def key(e):
    return (e["title"], e["place"], e["start"])


def cmd_list(city=None):
    for e in sorted(load("events.json"), key=lambda e: e["start"]):
        if city and e["city"] != city:
            continue
        print(f'{e["city"]}\t{e["start"]}~{e["end"]}\t{e["title"]}')


def cmd_merge(path):
    new = json.loads(Path(path).read_text(encoding="utf-8"))
    places, events = load("places.json"), load("events.json")
    places.update(new.get("places", {}))
    have = {key(e) for e in events}
    added, skipped = [], []
    for e in new.get("events", []):
        if key(e) in have or any(w in e["title"] for w in IGNORE):
            skipped.append(e["title"])
            continue
        added.append(e)
    events += added
    save("places.json", places)
    save("events.json", events)
    print(f"新增 {len(added)}，跳過 {len(skipped)}，共 {len(events)} 筆")
    for t in skipped:
        print("  跳過：", t)
    meta = load("meta.json")
    meta["updated"] = date.today().isoformat()
    for c in {e["city"] for e in new.get("events", [])} & set(meta["cities"]):
        meta["cities"][c]["updated"] = date.today().isoformat()  # 只更新這次有查的縣市
    save("meta.json", meta)
    return cmd_validate()


def cmd_validate():
    meta, places, events = load("meta.json"), load("places.json"), load("events.json")
    need = ["title", "city", "type", "place", "spot", "start", "end", "works", "url"]
    errors = []
    for i, e in enumerate(events):
        tag = f'#{i} {e.get("title", "?")}'
        errors += [f"{tag}：缺少 {k}" for k in need if not e.get(k)]
        if e.get("city") not in meta["cities"]:
            errors.append(f'{tag}：縣市代碼 {e.get("city")} 不在 meta.json')
        if e.get("type") not in meta["types"]:
            errors.append(f'{tag}：類型代碼 {e.get("type")} 不在 meta.json')
        if e.get("place") not in places:
            errors.append(f'{tag}：地點代碼 {e.get("place")} 不在 places.json')
        try:
            if date.fromisoformat(e["start"]) > date.fromisoformat(e["end"]):
                errors.append(f"{tag}：開始日晚於結束日")
        except (KeyError, ValueError):
            errors.append(f"{tag}：日期格式錯誤")
        if any(w.startswith("共 ") for w in e.get("works", [])):
            errors.append(f"{tag}：作品清單不要用「共 N 部」")
    for k, p in places.items():
        if p.get("city") not in meta["cities"]:
            errors.append(f'地點 {k}：縣市代碼 {p.get("city")} 不在 meta.json')
            continue
        if "lat" not in p or "lng" not in p:
            errors.append(f"地點 {k}：缺少座標，請跑 geocode")
        elif (c := meta["cities"][p["city"]].get("center")) and km((p["lat"], p["lng"]), c) > MAX_KM:
            errors.append(f"地點 {k}：座標離縣市中心超過 {MAX_KM} km，可能查錯")
    print("檢查通過" if not errors else "\n".join(errors))
    return 0 if not errors else 1


def geocode_one(query):
    import time
    import urllib.parse
    import urllib.request
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "json", "limit": 1, "countrycodes": "tw", "accept-language": "zh-TW"})
    req = urllib.request.Request(url, headers={"User-Agent": "ACG-Site-geocoder/1.0 (static site data script)"})
    time.sleep(1.1)  # Nominatim 使用規範：每秒最多 1 次
    with urllib.request.urlopen(req, timeout=20) as r:
        hits = json.loads(r.read().decode("utf-8"))
    return (float(hits[0]["lat"]), float(hits[0]["lon"])) if hits else None


def km(a, b):
    from math import asin, cos, radians, sin, sqrt
    la1, lo1, la2, lo2 = map(radians, (a[0], a[1], b[0], b[1]))
    h = sin((la2 - la1) / 2) ** 2 + cos(la1) * cos(la2) * sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * asin(sqrt(h))


MAX_KM = 30  # 查到的座標離縣市中心超過這個距離就當作查錯


def cmd_geocode():
    """幫沒有 lat/lng 的地點查座標：先用地址，查不到再用「縣市 + 地點名稱」"""
    meta, places = load("meta.json"), load("places.json")
    todo = [k for k, p in places.items() if "lat" not in p]
    failed = []
    for k in todo:
        p = places[k]
        c = meta["cities"].get(p["city"], {})
        city, center = c.get("label", ""), c.get("center")
        addr = p.get("addr", "")
        tries = [addr, addr.split("號")[0] + "號" if "號" in addr else "", f'{city} {p["label"]}']
        hit = None
        for q in filter(None, dict.fromkeys(tries)):
            try:
                hit = geocode_one(q)
            except Exception as e:  # 網路錯誤就換下一個查詢字串
                print("  查詢失敗：", q, e)
            if hit and center and km(hit, center) > MAX_KM:
                print(f"  {q} 查到的座標離{city}市中心 {km(hit, center):.0f} km，不採用")
                hit = None
            if hit:
                break
        if hit:
            p["lat"], p["lng"] = round(hit[0], 6), round(hit[1], 6)
            print(f'{k}\t{p["label"]}\t{p["lat"]}, {p["lng"]}')
        else:
            failed.append(f'{k}（{p["label"]}）')
        save("places.json", places)  # 每筆都存，中斷也不會白查
    print(f"完成 {len(todo) - len(failed)}／{len(todo)}")
    for f in failed:
        print("  查不到，請手動在 places.json 補 lat/lng：", f)


def cmd_covered(city, until):
    """記錄某縣市這次 AI 查詢涵蓋到哪一天（時間軸上會畫出界線）"""
    meta = load("meta.json")
    if city not in meta["cities"]:
        print(f"縣市代碼 {city} 不在 meta.json")
        return 1
    date.fromisoformat(until)
    meta["cities"][city]["coveredUntil"] = until
    meta["cities"][city]["updated"] = date.today().isoformat()
    save("meta.json", meta)
    print(f'{meta["cities"][city]["label"]} 資料查到 {until}')


def cmd_prune():
    cutoff = (date.today() - timedelta(days=31)).isoformat()
    events = load("events.json")
    keep = [e for e in events if e["end"] >= cutoff]
    used = {e["place"] for e in keep}
    places = {k: v for k, v in load("places.json").items() if k in used}
    save("events.json", keep)
    save("places.json", places)
    print(f"刪除 {len(events) - len(keep)} 筆結束於 {cutoff} 之前的活動，剩 {len(keep)} 筆")


if __name__ == "__main__":
    cmds = {"list": cmd_list, "merge": cmd_merge, "validate": cmd_validate, "prune": cmd_prune, "geocode": cmd_geocode, "covered": cmd_covered}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        print(__doc__)
        sys.exit(1)
    sys.exit(cmds[sys.argv[1]](*sys.argv[2:]) or 0)
