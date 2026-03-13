# WhaleCode Panel Review Report

**Tarih:** 2026-03-13
**Katilimcilar:**
- **Emre K.** — Product Manager (PM)
- **Defne A.** — Senior System Designer (SSD)
- **Ceren Y.** — UI/UX Designer (UXD)
- **Burak T.** — Senior Software Engineer (SSE)

**Konu:** WhaleCode'un mevcut durumu, gelecegi, gereksiz feature'lar, bozuk kisimlar ve yol haritasi

---

## 1. MEVCUT DURUM DEGERLENDIRMESI

### Emre (PM):
> 12,372 satir Rust, ~10,000 satir React. MVP olarak baktigimizda cogu sey yerinde: agent detection, orchestration (3 faz), kanban board, code review gate, usage tracking, git integration, worktree isolation. Ama "calisir gibi gorunen" seyler ile "gercekten calisan" seyler arasinda ciddi fark var. Kullanici perspektifinden soyluyorum: happy path calisiyor, ama hata aninda kullanici karanliga gomulur.

### Defne (SSD):
> Mimari temelde saglikli. Rust backend'de ToolAdapter trait ile polimorfizm, process group izolasyonu (setpgid), watch channel'lar ile polling-free bekleme, TOCTOU onleme (reserved_tools) — bunlar dogru kararlar. Ama 3 kritik mimari borcumuz var:
>
> 1. **Hata tipleri yok** — Her sey `Result<T, String>`. Production'da bu kabul edilemez. Error enum'lari lazim.
> 2. **Konfigurasyon yok** — Retry sayisi, timeout, cache TTL, wave concurrency hepsi hardcoded. Tek bir config dosyasi lazim.
> 3. **Rate limiting entegre degil** — Adapter'lar rate limit algilar ama kimse bu bilgiyi kullanmaz. Tamamen dead code.

### Ceren (UXD):
> UI'in visual quality'si iyi — dark theme tutarli, agent renkleri (violet/blue/emerald) taniniyor, status dot'lar anlamli. Ama UX felsefesi eksik. Kullanici bir sorun yasadiginda ne goruyor? Hicbir sey. Error boundary yok, loading skeleton yok, empty state yok, confirmation dialog yok. "Merge" butonuna basiyorsun, basarili mi basarisiz mi anlamiyorsun. Terminal'e bakmazsan hata gormuyor bile.

### Burak (SSE):
> Kod kalitesi genel olarak iyi ama 3 dosya proje icin teknik borc uretiyor:
> - **useTaskDispatch.ts** (599 satir) — Hem single-task hem orchestration dispatch, hem NDJSON parsing, hem DAG tracking, hem log filtering hep ayni dosyada. Bu dosyayi bolmek sart.
> - **TaskDetail.tsx** (966 satir) — En buyuk component. Icinde diff viewer, merge UI, reassign, retry hepsi var. 4 ayri component olmali.
> - **SetupPanel.tsx** (850 satir) — 3 adimli wizard inline style'larla dolu. Her step ayri component olmali.

---

## 2. BOZUK VEYA YARIM CALISAN OZELLIKLER

### 2.1 Rate Limiting (DEAD CODE) ❌
**Defne:** Tum adapter'lar `detect_rate_limit()` implement eder. `RetryPolicy` tanimli. `retry_delay_ms()` fonksiyonu var. Ama hicbir yerde cagirilmiyor. Orchestration icindeki worker dispatch'te rate limit algilanirsa ne olacak? Hicbir sey — process crash'ler, kullanici "Failed" goruyor.

**Karar:** 🔴 **DUZELT** — Rate limit tetiklendiginde exponential backoff ile retry. UI'da countdown goster.

### 2.2 Question Relay (YARIM) ⚠️
**Burak:** Backend'de `detect_question()`, `PendingQuestion`, `answer_user_question()` hepsi var. Ama Phase 2'de worker soru sordigunda master'a relay mekanizmasi implemente edilmemis. `wait_for_worker_with_questions()` fonksiyonu var ama icerideki relay logicleri eksik.

**Karar:** 🔴 **DUZELT** — Worker question → master relay → user notification zinciri tamamlanmali.

### 2.3 Context Database (YARIM) ⚠️
**Defne:** SQLite ContextStore var, `record_task_outcome()` tanimli, `query_agent_stats()` var. Ama orchestration bittiginde kimse `record_task_outcome()` cagirmiyor. Historical performance data toplanmiyor. Smart routing'in ihtiyaci olan `agent_stats` hep `None` geliyor.

**Karar:** 🟡 **SONRA DUZELT** — Routing simdilik keyword-based calisiyor. Stats entegrasyonu ikinci faz.

### 2.4 Process Timeout (YOK) ❌
**Burak:** Ne master ne worker icin timeout var. Bir agent takilirsa sonsuza kadar bekler. `child.wait()` uzerinde timeout yok. Production'da bu kabul edilemez.

**Karar:** 🔴 **DUZELT** — Master: 10 dakika timeout. Worker: 5 dakika. Configurable olmali.

### 2.5 Orchestration Plan Cleanup (YOK) ❌
**Defne:** `orchestration_plans` HashMap'i sonsuza kadar buyur. Plan tamamlansa bile memory'de kalir. 50 oturum sonra ciddi memory leak.

**Karar:** 🔴 **DUZELT** — Plan tamamlaninca 60 saniye sonra temizle.

### 2.6 Terminal Process Lookup (KIRIK) 🔴
**Burak:** Onceki oturumdan gelen bug — stale process ID sorununu cozdum ama temel problem devam ediyor: Terminal, interaktif process gerektiriyor, ama orchestration bitince master process oluyor. Yeni Quick Task dispatch'leri single-shot calistigi icin stdin kabul etmiyor. Terminal'de yazdigin komut asla iletilmiyor.

**Karar:** 🔴 **YENIDEN TASARLA** — Terminal iki modlu olmali: (1) Orchestration sirasinda master'a baglanir, (2) Orchestration bittikten sonra yeni interaktif process baslatir.

### 2.7 Selective Merge (UYUMSUZ) ⚠️
**Defne:** `selective_merge()` backend'de 577 satir conflict detection + resolution kodu var. Ama orchestration hicbir yerde cagirmiyor. Phase 2 → Phase 3 gecisinde conflict check yok. Varsayim "soft prevention calisiyor" — ama multi-agent senaryoda bu garanti degil.

**Karar:** 🟡 **SONRA ENTEGRE ET** — Phase 2 bitiminde conflict scan ekle, varsa UI'da goster.

---

## 3. GEREKSIZ / CIKARILABILECEK OZELLIKLER

### 3.1 Auto-PR Feature
**Emre:** `autoPr` flag'i store'da tanimli ama hicbir sey yapmaz. `gh pr create` integrasyonu yok. Kullaniciya "Auto PR" toggle'i gostermek yaniltici.

**Ceren:** Katiliyorum. Toggle gosterip ama calismazsa guvensizlik olusturur.

**Karar:** 🔴 **CIKAR** — Toggle'i UI'dan kaldir. Ileride implement edince geri ekle.

### 3.2 DeveloperTerminal Alt Component'leri
**Burak:** `components/terminal/DeveloperTerminal.tsx`, `OutputConsole.tsx`, `ProcessPanel.tsx` — bunlar TerminalView icine entegre edilmis ama ayni zamanda ayri component olarak da var. Ikisi de kullaniliyor, logic cakisiyor.

**Karar:** 🟡 **BIRLESTIR** — Tek bir TerminalView + OutputPane yapisi yeterli.

### 3.3 useClaudeTask / useGeminiTask / useCodexTask Hook'lari
**Burak:** Bu 3 hook birebir ayni yapida, sadece parse fonksiyonu degisiyor. useTaskDispatch zaten hepsini handle ediyor. Bu hook'lar eski mimariden kalma.

**Defne:** Adapter pattern backend'de var, frontend'de de olmali. 3 ayri hook yerine tek bir `useAgentTask(adapter)` pattern'i yeterli.

**Karar:** 🟡 **DEPRECATE** — Yeni tasklarda kullanma, eski referanslari temizle.

### 3.4 Prompt Optimization
**Emre:** `optimize_prompt()` komutu export ediliyor ama cagiran yok. Kullaniciya sunulan bir UI yok.

**Karar:** 🔴 **BEKLET** — Simdilik dead code olarak kalsin, ileride "Smart Prompt" feature ile entegre edilir.

### 3.5 AGENT_ICON / AGENT_LABEL Duplikasyonu
**Ceren:** 5+ component'te ayni AGENT_ICON ve AGENT_LABEL objeleri copy-paste. Bir agent eklenince 5 dosya degismeli.

**Karar:** 🔴 **BIRLESTIR** — `lib/agents.ts` dosyasina tasi, tek kaynak.

---

## 4. EKLENMESI GEREKEN OZELLIKLER

### 4.1 Error Boundary + User-Facing Error States 🔴 KRITIK
**Ceren:** Herhangi bir view crash'lerse tum uygulama beyaz ekran veriyor. Kullanici ne oldugundan habersiz.

**Emre:** Bu MVP icin bile kabul edilemez. Bir kullanicinin guveni bir kere kirilirsa geri kazanmak cok zor.

**Plan:**
- React Error Boundary component (her view'i sarar)
- Fallback UI: "Bir seyler ters gitti. Sayfayi yenile veya yeni oturum baslat."
- Toast notification sistemi (basari, hata, uyari)
- Failed IPC cagrilarinda retry butonu

### 4.2 Session Persistence (localStorage) 🟡 ONEMLI
**Emre:** Uygulama kapaninca her sey sifirlanir. Kullanici 30 dakika orchestration sonrasi sonuclari inceleyemeden kaza ile kapatirsa her sey kayip.

**Defne:** localStorage ile full state serialize riski var (circular refs, buyuk Map'ler). Daha iyisi: sadece kritik verileri kaydet — session name, project dir, task listesi, phase, results.

**Plan:**
- Zustand persist middleware ile kritik state'lerin snapshot'ini kaydet
- Uygulama acilisinda "Devam eden oturum bulundu. Devam etmek ister misin?" dialog'u
- Son 5 oturumun gecmisi (sidebar'da veya settings'te)

### 4.3 Keyboard Shortcuts 🟡 ONEMLI
**Ceren:** Power user'lar icin masastu uygulamasinda klavye kisayollari sart:
- `Cmd+K` → Quick Task
- `Cmd+1/2/3/4/5` → Tab gecisi (Board/Terminal/Usage/Git/Code)
- `Cmd+Enter` → Run/Approve
- `Escape` → Panel kapat
- `Cmd+R` → Retry failed task
- `Cmd+M` → Merge secili branch

**Plan:** Global `useHotkeys` hook, Settings'te customize edilebilir.

### 4.4 Task Approval Screen (Phase 1.5) 🟡 ONEMLI
**Emre:** Vision doc'ta var ama implement edilmemis. Master decompose ettikten sonra kullanici task listesini gormeli, duzenleyebilmeli, onaylamali. Simdi direkt execution'a geciyor.

**Ceren:** Bu cok onemli. Kullanici kontrolu hissetmeli. Decomposition yanlis olabilir — kullanici duzeltebilmeli.

**Plan:**
- Phase 1 bitiminde Kanban'da "Taslak" gorunumu
- Drag-drop ile task siralama
- Agent reassign (card uzerinde)
- Task ekleme / cikarma
- "Onayla ve Baslat" butonu

### 4.5 Confirmation Dialogs 🔴 KRITIK
**Ceren:** Merge, Cancel, Retry gibi geri donusu olmayan aksiyonlarda confirmation yok. Kullanici yanlislikla merge yapabilir.

**Plan:**
- `useConfirmDialog` hook
- Merge → "Bu branch'i main'e merge etmek istediginize emin misiniz?"
- Cancel → "Bu gorevi iptal etmek istediginize emin misiniz? Islem geri alinamaz."
- Retry → "Gorevi ayni agent ile tekrar denemek istiyor musunuz?"

### 4.6 Loading & Empty States 🟡 ONEMLI
**Ceren:** Board bos oldugunda beyaz ekran. Task yukleniyor oldugunda hicbir feedback yok.

**Plan:**
- Skeleton loader: Kanban card placeholder
- Empty state: "Henuz gorev yok. Baslat butonuna tiklin veya + New Task ile ekleyin."
- Loading spinner: IPC cagrilari sirasinda
- Progress indicator: Merge islemi sirasinda

### 4.7 Notification / Toast System 🔴 KRITIK
**Emre:** Kullanici feedback almak zorunda. Merge basarili → yesil toast. Task failed → kirmizi toast. Rate limit → sari uyari.

**Ceren:** Sonner veya react-hot-toast kucuk ve etkili. Asiri karmasik olmamali.

**Plan:**
- `sonner` kutuphanesi (2KB, headless)
- Basari: "Branch basariyla merge edildi"
- Hata: "Merge basarisiz: Conflict var"
- Uyari: "Claude rate limit — 30 saniye bekleniyor"
- Info: "Yeni gorev eklendi"

### 4.8 Configurable Timeouts & Limits 🟡 ONEMLI
**Defne:** Tum hardcoded degerler tek bir config'e tasinmali:
```
[orchestration]
master_timeout_ms = 600000
worker_timeout_ms = 300000
max_retries = 2
retry_base_delay_ms = 5000
max_concurrent_workers = 4

[ui]
output_buffer_lines = 50
result_summary_max_chars = 800
progress_bar_duration_ms = 120000
```

**Plan:** Rust tarafinda `config.toml`, frontend tarafinda Settings view'da editable.

---

## 5. MIMARI IYILESTIRMELER

### 5.1 Error Type Hierarchy (Rust)
**Defne:**
```rust
#[derive(thiserror::Error, Debug)]
enum WhaleError {
    #[error("Process error: {0}")]
    Process(#[from] ProcessError),
    #[error("Orchestration error: {0}")]
    Orchestration(#[from] OrchestrationError),
    #[error("Git error: {0}")]
    Git(#[from] git2::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
```
Frontend bu error type'lari alip uygun UI gosterebilir.

### 5.2 Message Schema (Backend → Frontend)
**Burak:** Simdi orchestrator mesajlari serbest metin:
```
"Assigned to claude: Fix the bug"
"Completed (exit 0): Summary here"
"[orchestrator] Wave 2/3: 2 task(s)"
```

Frontend bunlari 10+ regex ile parse ediyor. Fragile ve hata egilimli. Bunun yerine:

```json
{"type": "task_assigned", "agent": "claude", "dag_id": "t1", "description": "Fix the bug"}
{"type": "task_completed", "dag_id": "t1", "exit_code": 0, "summary": "Done"}
{"type": "wave_progress", "current": 2, "total": 3, "task_count": 2}
```

**Defne:** Bu en onemli mimari degisiklik. Regex-based parsing production'da kirilamaz. JSON schema ile type-safe iletisim sart.

**Karar:** 🔴 **EN YUKSEK ONCELIK** — Backend'den structured JSON events gondermek. Frontend regex'leri kaldirmak.

### 5.3 Frontend Code Splitting
**Burak:**
- `useTaskDispatch.ts` → `useOrchestratedDispatch.ts` + `useSingleTaskDispatch.ts` + `useDispatchUtils.ts`
- `TaskDetail.tsx` → `TaskDetail.tsx` + `InlineDiffViewer.tsx` + `TaskMergePanel.tsx` + `TaskRetryPanel.tsx`
- `SetupPanel.tsx` → `SetupPanel.tsx` + `StepSession.tsx` + `StepAgents.tsx` + `StepTask.tsx`

### 5.4 Centralized Agent Config
**Ceren + Burak:**
```typescript
// lib/agents.ts
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    letter: 'C',
    gradient: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)',
    color: '#8b5cf6',
    model: 'Claude 4 Sonnet',
  },
  gemini: { ... },
  codex: { ... },
} as const;
```
Tum component'ler buradan okur.

---

## 6. ONCELIKLENDIRME VE YOL HARITASI

### Faz 1: Stabilite (1-2 hafta)
| # | Is | Oncelik | Sorumluluk |
|---|-----|---------|------------|
| 1 | Structured JSON events (backend → frontend) | 🔴 Kritik | SSE + SSD |
| 2 | Error Boundary + Toast notification | 🔴 Kritik | UXD + SSE |
| 3 | Confirmation dialogs (merge, cancel, retry) | 🔴 Kritik | UXD |
| 4 | Process timeout (master + worker) | 🔴 Kritik | SSE |
| 5 | Rate limit retry entegrasyonu | 🔴 Kritik | SSE |
| 6 | Plan cleanup (memory leak fix) | 🔴 Kritik | SSE |
| 7 | Auto-PR toggle'i cikar (dead feature) | 🔴 Kolay | SSE |
| 8 | AGENT_ICON/LABEL merkezilestir | 🔴 Kolay | SSE |

### Faz 2: Kullanilabilirlik (2-3 hafta)
| # | Is | Oncelik | Sorumluluk |
|---|-----|---------|------------|
| 9 | Loading states + empty states + skeleton | 🟡 Onemli | UXD |
| 10 | Keyboard shortcuts | 🟡 Onemli | SSE + UXD |
| 11 | Session persistence (localStorage) | 🟡 Onemli | SSE + SSD |
| 12 | Task Approval Screen (Phase 1.5) | 🟡 Onemli | PM + UXD + SSE |
| 13 | Terminal yeniden tasarimi (iki mod) | 🟡 Onemli | SSE |
| 14 | Config dosyasi (timeout, retry, limits) | 🟡 Onemli | SSD |
| 15 | Question relay tamamla | 🟡 Onemli | SSE |

### Faz 3: Kalite (2-3 hafta)
| # | Is | Oncelik | Sorumluluk |
|---|-----|---------|------------|
| 16 | Error type hierarchy (thiserror) | 🟢 Iyi | SSD |
| 17 | useTaskDispatch bolme (3 dosya) | 🟢 Iyi | SSE |
| 18 | TaskDetail bolme (4 component) | 🟢 Iyi | SSE |
| 19 | SetupPanel bolme (3 step component) | 🟢 Iyi | SSE |
| 20 | Context DB entegrasyonu (stats tracking) | 🟢 Iyi | SSD |
| 21 | Conflict detection entegrasyonu | 🟢 Iyi | SSE |
| 22 | Integration testleri | 🟢 Iyi | SSE |
| 23 | Inline style → CSS/Tailwind migration | 🟢 Iyi | UXD |

---

## 7. RISK ANALIZI

| Risk | Olasilik | Etki | Onlem |
|------|---------|------|-------|
| Agent CLI API degisikligi (claude/gemini) | Yuksek | Yuksek | Adapter version pinning + integration test |
| Rate limit cascade (tum agent'lar blocked) | Orta | Yuksek | Fallback queue + user notification |
| Memory leak uzun oturumlarda | Yuksek | Orta | Plan cleanup + output buffer cap |
| Git merge conflict veri kaybi | Dusuk | Yuksek | Conflict check before merge + backup |
| Tauri v2 breaking change | Dusuk | Orta | Version lock + migration guide takip |

---

## 8. SONUC

### Emre (PM):
> WhaleCode'un core value proposition'i guclu: "tek butonla birden fazla AI agent'i orkestra et." Ama simdiki haliyle bir alpha-quality product. Beta'ya cikmak icin Faz 1'deki 8 maddeyi tamamlamamiz lazim. Ozellikle structured events ve error handling olmadan kullanici guveni kuramayiz.

### Defne (SSD):
> Mimari temeli saglam ama teknik borc birikiyor. En acil is: string-based error handling'den kurtulmak ve hardcoded limitleri config'e tasimak. Ayrica regex-based message parsing'i JSON events'a donusturmek sart — bu hem frontend hem backend'i sadelestirir.

### Ceren (UXD):
> Gorseller iyi ama "kullanici deneyimi" eksik. Kullanici hata gormedigi surece mutlu — ama ilk hata aninda cozumsuz kaliyor. Toast, confirmation, loading state ve empty state eklemeliyiz. Bunlar basit ama "urun hissiyatini" tamamen degistirir.

### Burak (SSE):
> Oncelikler: (1) Structured events — bu tek basina useTaskDispatch'teki 200 satir regex'i siler. (2) Process timeout — production'da mecburi. (3) Component decomposition — 966 satirlik component sürdürülebilir degil. Faz 1'i 2 haftada bitirebiliriz.

---

*Rapor sonu. Bir sonraki adim: Faz 1 icin detayli plan olusturmak.*
