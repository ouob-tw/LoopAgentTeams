# QA 預設用 gpt-6.1-terra 還是直接用 gpt-6.1-sol

調查日期：2026-11-29，Asia/Taipei。對應 ouob-tw/LoopAgentTeams-work#768。僅調查，未修改技能、程式或任何 `.lat` 紀錄。

## 結論

**建議整體預設維持 terra `medium`；需要 passkey 或登入工作階段邊界的安全類驗收，可考慮直接用 sol（需使用者決定，樣本小）。其餘先改善第一輪 QA 的任務說明。**

- 11-10 起 terra 先驗的 280 張票中，30 張（10.7%）又派了第二位 QA，19 張（6.8%）第二位含 sol；真正「sol 接手 terra 沒證實的項目」是 **18 張（6.4%）**。
- 11-28 明顯偏高：當天 16 張中 5 張（31%），先前各期間為 2%–7%。這 5 張集中在同一專案同一天，其中 3 張是同一批功能；還不能當成長期趨勢。
- 票上「#756 #759 #760 #761 #764 每張都再派 sol」大致成立，但 #764 到資料截止時沒有第二位 QA：報告把真實整合留給最後的整體驗收。
- 接手任務通常同時**縮小範圍並補上做法或授權**。現有資料分不出 sol 的成功有多少來自模型、多少來自第二份任務說明。

## 資料範圍與算法

| 項目 | 定義 |
|---|---|
| 來源 | 本機各專案（以 A–I 代稱，A 是本專案）的 `.lat/ledgers/*.json`、`.lat/tasks/` 任務卡、`.lat/runs/` QA 報告、`.lat/problems.jsonl`、`.lat/decisions/`；本機 Codex 對話紀錄（用量）；票的標題（`gh issue list`）；ouob-tw/LoopAgentTeams-work#380、#521。主因分類只用帳本、任務說明與報告，沒有另查 `hcom events`／`hcom transcript` |
| 期間 | 帳本列的派工時間在 2026-10-28 00:00 至 11-28 24:00（台灣時間），且狀態為 `done`。之後才派工或結案的不在內 |
| 模型 | 帳本實際記錄的模型（`actual`）優先，沒有才用任務卡 `model` |
| 分母 | QA 預設改為 terra（commit `c1e7f329`，11-10 13:41）後，第一個 `qa` 列是 terra 的票。一列涵蓋多張票時逐票各算一次 |
| 第二位 QA | 同一票出現不同 Agent 的 `qa` 列。同一 Agent 複驗不算 |
| 接手 | **人工判讀**接手任務說明與兩份報告後，確認是補第一位留下的 `UNPROVEN`／`NOT_EXECUTED`。清單寫在附錄腳本的 `MANUAL` |
| 任務種類 | 依序比對：標題含安全字詞 → 安全；標題含裝置字詞或改到原生程式 → 裝置／桌面；改到畫面檔（`.svelte`、`.css` 等） → 前端畫面；只改技能或文件 → 技能與文件；其他 → 後端。改檔取自帳本交付 commit 與提到票號的 commit |

限制：任務種類是規則分類，會有誤分（例如倒數顯示的票被分到後端）；只有 A、B、D 三個專案取了標題，其他專案的安全類可能少算。不同專案的同號 commit 或跨倉庫票號也可能干擾分類。

## 1. 各任務種類

### 實際驗收

| 種類 | terra 先驗票數 | 有第二位 QA | 第二位含 sol | sol 接手未證實項目 | 接手的票 |
|---|--:|--:|--:|--:|---|
| 前端畫面 | 81 | 12 (14.8%) | 11 (13.6%) | **11 (13.6%)** | A#558 #563 #569 #572 #640 #692 #694 #756；B#191 #392 #393 |
| 安全相關 | 26 | 6 (23.1%) | 4 (15.4%) | **4 (15.4%)** | A#620 #744 #760 #761 |
| 後端／伺服器 | 106 | 5 (4.7%) | 4 (3.8%) | 3 (2.8%) | A#641 #759；D#25 |
| 技能與文件 | 28 | 1 (3.6%) | 0 | 0 | — |
| 裝置／桌面 | 34 | 6 (17.6%) | 0 | 0 | — |
| 無法分類 | 5 | 0 | 0 | 0 | — |
| 合計 | 280 | 30 (10.7%) | 19 (6.8%) | 18 (6.4%) | |

- 沒算成接手的 12 張第二位 QA：修正或重新部署後複驗、依平台分工、其他範圍的收尾驗收，以及一張 Codex 額度用完改派 Claude Sonnet（B#307）。裝置類的第二位 QA 都屬這些情況。
- 第 19 張含 sol 的是 B#405：同一規格下另一個獨立範圍，不算接手。
- 依專案：A 14/144、B 3/77、C 0/32、D 1/17、其餘 0/10。

### QA 草稿

terra 先寫草稿的 193 張票中，只有 1 張出現第二位草稿 QA，且不是 sol。草稿沒有需要換 sol 的跡象。

### 沒有接手不代表全部證實

沒有第二位 QA 的 250 張票中，找得到報告的 245 張裡，至少 57 張（23%）在結論或統計行寫明仍有 `UNPROVEN`（文字比對的下限；206 張提到這個詞，但包含「0 UNPROVEN」之類）。因此 6.4% 是「主控實際加派」的比例，不是 terra 的證實失敗率。

## 2. terra 為何留下 UNPROVEN

18 張接手票併為 17 組（#640、#641 同一次驗收），每組人工歸一個主因：

| 主因 | 組數 | 代表案例 |
|---|--:|---|
| 環境看來可做，但情境沒做完 | 8 | A#756 沒比對修改前版本、沒測執行中與警告狀態；A#761 推播、過期、撤銷登入等整批未執行；另有 #558 #563 #569 #572 #692 #760 |
| 測試環境、假資料或工具不足 | 7 | A#744 隔離看板是 HTTP，passkey 做不了；A#640 示範資料訊息太少；A#694 真實輔助程式的假資料沒建起來；另有 #620、B#191、B#392、D#25 |
| 沒用真實身分或真實模型 | 2 | A#759 任務卡限定暫存紀錄，沒從自己的真實 Agent 程序送出；B#393 假模型無法證明自動命名（#761 也有同樣的次要原因） |

- **時間不夠**：抽讀接手票的第一輪報告並搜尋關鍵字，沒看到把它列為原因。接手組的 terra 第一輪中位數只有 5.5 分鐘。
- **不敢讀真實資料／用真實身分**：#759 是遵守隔離限制。接手任務明寫「用你自己的 shell、唯讀讀真實紀錄」後 sol 完成。這比較像授權寫法問題。
- 17 組中至少 12 組的接手任務附了具體做法或新授權：#558、#563、#572、#620、#640、#694、#744、#759、#760、B#392、B#393、D#25（例如指定 HTTPS 代理與虛擬認證器、沿用哪個假資料、可以用真實模型）。

### sol 接手的結果

- 多數指定項目轉為 `PASS`／`FAIL`；仍有剩下的：A#563 原生拖放、B#392 等待狀態與字型比對、D#25 兩項線上證據。
- 接手階段新記 8 個問題（甲 1、乙 3、丙 4）；同一批票 terra 第一輪記了 6 筆（乙 4、丙 2，含一筆彙總）。
- 最重要的一個是 A#761：登入過期後，已開啟的即時串流仍收到完整提案資料（甲級）。terra 把過期／撤銷登入列為未執行。
- terra 並非只會留白：A#692 第一輪自己找出 3 個缺陷並複驗修正（後來只有一個情境交給 sol）。

### 改預設前的同題比較（ouob-tw/LoopAgentTeams-work#380，10-30）

| 回合 | terra | sol |
|---|---|---|
| 簡單畫面題 | 2/2，覆蓋較窄 | 2/2，多測三種入口 |
| 較難畫面題 | 2/4（看到異狀但判 `UNPROVEN`） | 3/4 |
| 後端題 | 2 類＋1 誤判 | 2 類＋1 加分＋同一誤判 |

terra 每輪快約 2–3 分鐘，沒有一輪勝過 sol；當時使用者決定維持 sol（待決紀錄 VUHO-TERRA-4）。11-10 使用者再指示 QA 改由 terra 起手（#521）。每回合只有一個樣本。

## 3. 成本

時間是帳本列「派工 → 結案」（任務卡建立至結案的對應值），含等待實作者修正與暫停，不是純運算時間。

| 路徑 | 樣本 | QA 次數 | 各 QA 列分鐘合計：中位數（75 百分位） | 首派到末結案：中位數 |
|---|--:|---|--:|--:|
| 只有 terra | 235 組 | 1 位 | 6.3 (19.5) | 7.2 |
| terra＋sol 接手 | 17 組 | 2 位 | 14.3 (37.8) | 21.4 |
| 直接 sol（單一 Agent） | 8 組 | 1 位 | 36.1 (62.8) | 36.1 |

- 接手組：terra 第一輪中位數 5.5 分鐘，sol 接手 7.3 分鐘。直接用 sol 能省的是第一輪與交接；但沒有同題資料可知 sol 單獨做完要多久。
- 「直接 sol」是主控挑過的較難任務（主要是安全、裝置），只有 8 組，**不能**拿 36.1 分鐘推論 sol 比較慢。

### Token 用量

取各 Agent 本機 Codex 紀錄最後一筆累計值的中位數。只對得到一部分（terra 72/219、sol 13/26）。

| 範圍 | 模型 | 總量（含快取） | 未快取輸入 | 輸出 |
|---|---|--:|--:|--:|
| 全部對得到的 QA | terra | 6,013,249 | 114,404 | 13,567 |
| 全部對得到的 QA | sol | 4,784,697 | 126,601 | 18,281 |
| 接手票中兩邊都對到的 9 組 | terra 第一輪 | 4,312,067 | 116,191 | 12,635 |
| 接手票中兩邊都對到的 9 組 | sol 接手 | 2,900,064 | 97,477 | 13,058 |

接手路徑的用量大約是兩份相加。兩個模型每個 token 扣多少訂閱額度沒有取得，所以**無法比較額度或金額成本**。

## 4. 建議

| 範圍 | 建議 | 依據 |
|---|---|---|
| 後端、技能與文件、QA 草稿 | 維持 terra | 接手 3/106、0/28；草稿 0 次換 sol |
| 裝置／桌面 | 維持現狀 | 沒有任何 sol 接手；第二位多為分工或環境接續 |
| 一般前端畫面 | 維持 terra，改善任務說明 | 11/81 (13.6%) 接手；全部直接用 sol 會讓其餘約 86% 也改用 sol，且沒有額度資料支持 |
| 安全類中需要 passkey、虛擬認證器、登入過期／撤銷檢查者 | 可直接 sol（待決定） | 安全類接手 4/26，4 張都涉及登入或 passkey 相關驗收；#761 的甲級問題在接手時才發現 |

第一輪任務說明建議補三件事（對應上面的主因，效果尚未驗證）：

1. 寫明環境做法：HTTPS 代理與虛擬認證器、可沿用的假資料或測試輔助程式。
2. 寫明授權：哪些真實紀錄可唯讀、可否用自己的 Agent 身分、是否可呼叫真實模型與次數。
3. 項目多時要求逐項做完或寫出具體阻礙，不能以「未執行」整批結案。

改完兩週後用同一算法重算，再決定前端畫面是否也要例外。

## 需要使用者決定（本票不改技能）

1. **hcom-spawn 模型表**：是否加一個例外：「需要 passkey／虛擬認證器或登入工作階段邊界的 QA，直接用 `gpt-6.1-sol` `medium`」。建議：加；不加則維持現表。
2. **任務說明要求**：是否把上面三件事納入 QA 派工做法（屬 LAT／hcom-spawn 修改；依本專案偏好，能用輔助工具檢查的優先於增加規則文字）。
3. 是否整體改回 sol。建議：目前不改。

## 附錄：重現腳本

存成任意目錄的 `repro.py`，另備 `repos.json`（`{"<專案資料夾名>": "<擁有者/票倉庫>"}`，用來唯讀取得 A、B、D 的票標題），執行 `uv run --no-project python repro.py "$HOME" repos.json`。專案代號依 terra 先驗票數由多到少產生。帳本、commit 或本機對話紀錄之後變動時，數字可能不同（本次兩次執行間 terra 用量樣本差 1 筆）。

```python
import json,glob,os,re,sys,collections,subprocess,statistics as st,datetime as dt
HOME,REPOS=sys.argv[1],json.load(open(sys.argv[2]))
LO,HI,DEF='2026-10-27T16:00:00Z','2026-11-28T16:00:00Z','2026-11-10T05:41:43Z'
SEC=r'登入|密碼|passkey|權限|安全|授權|憑證|核准|login|auth|token|secret|分享'
DEV=r'android|安卓|\bios\b|macos|windows|桌面|虛擬機|手機 ?app|懸浮球|\bmask\b'
num=lambda t: re.findall(r'\d+',str(t).split('/')[-1]) or [str(t)]
ts=lambda x: dt.datetime.fromisoformat(x.replace('Z','+00:00'))
mins=lambda a,b:(ts(b)-ts(a)).total_seconds()/60
rows,impl=[],collections.defaultdict(list)
for lat in sorted(glob.glob(HOME+'/*/.lat')):
    ws=lat.split('/')[-2]; cards={os.path.basename(p):p for p in glob.glob(lat+'/tasks/**/*.md',recursive=True)}
    for f in glob.glob(lat+'/ledgers/*.json'):
        for r in json.load(open(f)).get('items',[]):
            if r.get('stage')=='impl':
                for n in num(r.get('ticket')): impl[ws,n]+=[(r.get('repo') or lat[:-5],c) for c in (r.get('evidence') or {}).get('commit',[])]
            a=r.get('assigned_at') or ''
            if r.get('stage') not in('qa','qa-draft') or r.get('status')!='done' or not LO<=a<HI: continue
            card=cards.get(os.path.basename(r.get('card') or ''))
            m=re.search(r'^- model[：:](.*)$',open(card).read(),re.M) if card else None
            act=r.get('actual') or {}; act=act.get('done') or act.get('bind') or {}
            s=re.search(r'terra|sol|astra|opus|sonnet|fable',act.get('model') or (m.group(1) if m else ''))
            done=r.get('done_at') or next((h['at'] for h in reversed(r['history']) if h['action']=='done'),None)
            rows.append(dict(ws=ws,stage=r['stage'],fam=s.group(0) if s else '?',agent=r['agent'],nums=num(r['ticket']),a=a,done=done))
def group(stage):
    t=collections.defaultdict(list)
    for r in sorted((r for r in rows if r['stage']==stage),key=lambda r:r['a']):
        for n in r['nums']: t[r['ws'],n].append(r)
    return t
Q,D=group('qa'),group('qa-draft')
post={k:v for k,v in Q.items() if v[0]['a']>=DEF}
T={k:v for k,v in post.items() if v[0]['fam']=='terra'}
follow=lambda v:[r for r in v if r['agent']!=v[0]['agent']]
# project aliases: A, B, C... by number of terra-first tickets
al={w:chr(65+i) for i,(w,_) in enumerate(collections.Counter(k[0] for k in T).most_common())}
ws_of={v:k for k,v in al.items()}
# manual coding: tickets where a later QA took over the first QA's UNPROVEN / NOT_EXECUTED items
MANUAL={'A':'558 563 569 572 620 640 641 692 694 744 756 759 760 761','B':'191 392 393','D':'25'}
TAKE={(ws_of[p],n) for p,s in MANUAL.items() for n in s.split()}
title={}
for ws,repo in REPOS.items():
    p=subprocess.run(['gh','issue','list','-R',repo,'--state','all','--limit','1000','--json','number,title'],capture_output=True,text=True,check=True)
    title.update({(ws,str(i['number'])):i['title'] for i in json.loads(p.stdout)})
def kind(k):
    found=list(impl.get(k,[]))
    for repo in {r for r,_ in found}|{f'{HOME}/{k[0]}'}:
        g=subprocess.run(['git','-C',repo,'log','--all','--format=%H','-E',f'--grep=#{k[1]}([^0-9]|$)','--until='+HI],capture_output=True,text=True)
        found+=[(repo,h) for h in g.stdout.split()]
    f=set()
    for repo,c in found:
        p=subprocess.run(['git','-C',repo,'show','--name-only','--format=','--diff-merges=first-parent',c],capture_output=True,text=True)
        f|={x for x in p.stdout.split('\n') if x}
    code=[x for x in f if not re.search(r'(^|/)tests?/|\.test\.|\.spec\.',x)] or list(f)
    t=title.get(k,'')
    if re.search(SEC,t,re.I): return 'security'
    if re.search(DEV,t,re.I) or any(re.search(r'\.(kt|swift|rs)$|android/|src-tauri',x) for x in code): return 'device'
    if any(re.search(r'\.(svelte|tsx|jsx|vue|css|scss|html)$',x) for x in code): return 'frontend'
    if code and all(x.endswith('.md') or x.startswith(('skills/','docs/')) for x in code): return 'skill-docs'
    return 'backend' if code else 'unclassified'
K={k:kind(k) for k in T}
print('qa rows',collections.Counter(r['fam'] for r in rows if r['stage']=='qa'))
print('draft rows',collections.Counter(r['fam'] for r in rows if r['stage']=='qa-draft'))
pre=[v for v in Q.values() if v[0]['a']<DEF]; print('before default: tickets',len(pre),collections.Counter(v[0]['fam'] for v in pre))
print('after default: first QA',collections.Counter(v[0]['fam'] for v in post.values()))
print('kind, terra-first, any 2nd agent, sol 2nd, takeover')
for kd in ['frontend','backend','skill-docs','security','device','unclassified',None]:
    ks=[k for k in T if kd in(None,K[k])]
    print(kd or 'TOTAL',len(ks),sum(bool(follow(T[k])) for k in ks),sum(any(r['fam']=='sol' for r in follow(T[k])) for k in ks),sum(k in TAKE for k in ks),sorted(al[k[0]]+'#'+k[1] for k in ks if k in TAKE) if kd else '')
day=lambda a:(ts(a)+dt.timedelta(hours=8)).date().isoformat()  # Asia/Taipei
for p,w in al.items(): print('project',w,sum(k[0]==p for k in T),sum(k[0]==p and k in TAKE for k in T))
for lo,hi in [('2026-11-10','2026-11-16'),('2026-11-17','2026-11-22'),('2026-11-23','2026-11-27'),('2026-11-28','2026-11-28')]:
    ks=[k for k,v in T.items() if lo<=day(v[0]['a'])<=hi]; print('period',lo,hi,len(ks),sum(k in TAKE for k in ks))
dp=[v for v in D.values() if v[0]['a']>=DEF and v[0]['fam']=='terra']
print('terra drafts: tickets',len(dp),'2nd agent',sum(bool(follow(v)) for v in dp),'sol 2nd',sum(any(r['fam']=='sol' for r in follow(v)) for v in dp))
uniq=lambda g:list({tuple((r['agent'],r['a']) for r in v):v for v in g}.values())
tk=uniq([T[k] for k in sorted(TAKE)])
for n,g in {'terra only':uniq(v for v in T.values() if not follow(v)),'terra+takeover':tk,
 'sol first, one agent':uniq(v for v in post.values() if v[0]['fam']=='sol' and not follow(v))}.items():
    s=[sum(mins(r['a'],r['done']) for r in v) for v in g]; w=[mins(v[0]['a'],max(r['done'] for r in v)) for v in g]
    print(n,'n',len(g),'QA minutes median',round(st.median(s),1),'p75',round(st.quantiles(s,n=4)[2],1),'wall median',round(st.median(w),1))
sol=lambda v:next(r for r in v if r['fam']=='sol')
print('takeover groups',len(tk),'first terra median',round(st.median(mins(v[0]['a'],v[0]['done']) for v in tk),1),'sol median',round(st.median(mins(sol(v)['a'],sol(v)['done']) for v in tk),1))
first={(v[0]['ws'],v[0]['agent']) for v in tk}; second={(v[0]['ws'],sol(v)['agent']) for v in tk}
c1,c2=collections.Counter(),collections.Counter()
for lat in glob.glob(HOME+'/*/.lat'):
    p=lat+'/problems.jsonl'
    for line in open(p) if os.path.exists(p) else []:
        x=json.loads(line); a=(lat.split('/')[-2],x.get('by'))
        if x.get('op')=='record' and x['at']<HI:
            if a in first: c1[x['level']]+=1
            if a in second: c2[x['level']]+=1
print('problems recorded on takeover tickets: first terra',dict(c1),'sol takeover',dict(c2))
want={r['agent']:r['fam'] for v in post.values() for r in v if r['fam'] in('terra','sol')}
tok={}
for p in glob.glob(HOME+'/.codex/sessions/2026/1[01]/*/*.jsonl')+glob.glob(HOME+'/.codex/archived_sessions/*2026-1[01]*.jsonl'):
    names,last=set(),None
    for line in open(p,errors='replace'):
        if 'Your name: ' in line: names|=set(re.findall(r'Your name: ([a-z0-9-]+)',line))
        if '"total_token_usage"' in line: last=line
    if len(names)==1 and last and (n:=names.pop()) in want:
        u=json.loads(last)['payload']['info']['total_token_usage']
        t=(u['total_tokens'],u['input_tokens']-u.get('cached_input_tokens',0),u['output_tokens'])
        tok[n]=max(t,tok.get(n,t))
med=lambda v:[int(st.median(x[i] for x in v)) for i in range(3)]
for f in('terra','sol'):
    v=[t for a,t in tok.items() if want[a]==f]; print('tokens',f,len(v),'of',sum(x==f for x in want.values()),'median total/uncached-in/out',med(v))
pr=[(tok[v[0]['agent']],tok[sol(v)['agent']]) for v in tk if v[0]['agent'] in tok and sol(v)['agent'] in tok]
print('takeover pairs',len(pr),'terra',med([a for a,b in pr]),'sol',med([b for a,b in pr]))
```
