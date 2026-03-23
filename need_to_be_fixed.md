# WhaleCode - Kapsamlı Kod İnceleme ve Hata Raporu (Needs to be Fixed)

Bu doküman, sistem mimarisi, backend, frontend, UI ve UX katmanlarında eşzamanlı çalışan 20'den fazla uzman analiz ajanının bulgularını özetlemektedir. Uygulamanın temel değer önermesi olan "Görevi anlama, parçalara bölme ve diğer ajanlara dağıtarak paralel çalıştırma" (Orkestrasyon) sürecini bozan temel nedenler burada listelenmiştir.

---

## 🚨 1. KRİTİK MİMARİ VE GÜVENLİK İHLALLERİ

### 1.1. Worktree İzolasyonunun By-pass Edilmesi (Veri Çakışması)

- **Dosya:** `src-tauri/src/commands/codex.rs` ve `src-tauri/src/commands/orchestrator.rs`
- **Sorun:** Projenin temel güvenlik vaadi ajanların izole Git worktree'lerinde çalışmasıdır. Ancak mevcut orkestrasyon (Phase 2) ve Codex entegrasyonu bu izolasyonu tamamen atlayıp doğrudan ana `project_dir` üzerinde çalışmaktadır.
- **Etki:** Paralel çalışan ajanlar aynı anda aynı dosyalara ve `.git/index.lock` dosyasına müdahale ettiği için yarış durumları (race conditions), git kilitlenmeleri ve kod ezilmeleri yaşanmaktadır. Çakışma tespiti (Conflict Detection) işlevsiz kalmaktadır.

### 1.2. Eşzamanlılık (Concurrency) Kilidi Darboğazı

- **Dosya:** `src-tauri/src/commands/router.rs`
- **Sorun:** Orkestratör görevleri paralel dalgalar (waves) halinde çalıştırmak üzere tasarlanmış olsa da, `dispatch_task` fonksiyonu içindeki `acquire_tool_slot` mekanizması "aynı araçtan sadece 1 tane çalışabilir" şeklinde global bir kilit (mutex) uygulamaktadır.
- **Etki:** Orkestratör iki görevi aynı anda "Claude" ajanına atadığında, ilki çalışırken ikincisi kilit nedeniyle anında çökmektedir.

---

## ⚙️ 2. BACKEND VE ÇEKİRDEK (RUST) HATALARI

### 2.1. DAG (Bağımlılık Grafiği) Çöküşü ve Veri Kaybı

- **Dosya:** `src-tauri/src/router/orchestrator.rs` ve `src-tauri/src/commands/orchestrator.rs`
- **Sorun:** Master ajan görevleri bölerken her alt göreve bir `id` atamaktadır (LLM çıktısı). Ancak `SubTaskDef` struct'ı içinde `pub id: String` tanımlanmadığı için JSON parse edilirken bu ID'ler sessizce düşürülmektedir.
- **Etki:** Orkestratör eksik ID'leri yerine indeks (t1, t2) koymaya çalışırken `depends_on` (bağımlılık) zinciri kırılmaktadır. DAG hatası yakalandığında sistem tüm görevleri mantıksızca *tek bir paralel dalgada* çalıştırmaya zorlamaktadır.

### 2.2. Sessiz Git Hataları ve Stale (Eski) Worktree Birikimi

- **Dosya:** `src-tauri/src/worktree/conflict.rs` ve `src-tauri/src/worktree/manager.rs`
- **Sorun:** `git merge --abort` gibi temizlik işlemleri ve klasör silme komutları `let _ =` ile yutulmaktadır.
- **Etki:** Klasör veya branch silinemediğinde sistem hata vermeden devam etmekte, ancak `.whalecode-worktrees` klasörü çöplerle dolmakta ve gelecekteki görevler aynı isimli branch'ler yüzünden çökmektedir.

### 2.3. Süreç (Process) Çıktı Gecikmesi ve Kaybı

- **Dosya:** `src-tauri/src/process/manager.rs`
- **Sorun:** Ajan logları `BufReader::lines()` ile satır satır okunmaktadır. Yapay zeka stream'leri satır sonu (`\n`) karakteri basmadan token gönderdiğinde loglar UI'a gitmeyip hafızada bekletilmektedir. Byte-chunk tabanlı okumaya geçilmelidir.

---

## 💻 3. FRONTEND (REACT / ZUSTAND) HATALARI

### 3.1. "activePlan" Race Condition (Onay Butonlarının Çalışmaması)

- **Dosya:** `src/hooks/orchestration/handleOrchEvent.ts` ve `TaskApprovalView.tsx`
- **Sorun:** Frontend `dispatchOrchestratedTask` komutu resolve olana kadar `activePlan` state'ini set etmemektedir. Ancak orkestratör görevleri bölüp "onay bekliyor" aşamasına geçtiğinde promise henüz resolve olmamıştır.
- **Etki:** `activePlan` boş (null) olduğu için `TaskApprovalView` içindeki "Approve" (Onayla) butonları veya otomatik onaylama mantığı hiçbir şey yapmadan sessizce kapanmaktadır.

### 3.2. Zustand Map Performans Sorunu ve Gereksiz Render'lar

- **Dosya:** `src/stores/taskStore.ts`
- **Sorun:** Görev logları her 500ms'de bir güncellendiğinde Zustand içindeki tüm `Map` objesi yeniden oluşturulmaktadır.
- **Etki:** Tüm Kanban panosu ve sekmeler sürekli baştan render edilerek ağır UI donmalarına (jank) yol açmaktadır.

### 3.3. Görev Tamamlama Sırası (FIFO) Hatası

- **Dosya:** `src/hooks/orchestration/handleOrchEvent.ts`
- **Sorun:** Ajanların paralel çalışıp farklı sürelerde bitirmesi gerekirken, Frontend `task_completed` mesajlarını bir kuyruk mantığıyla (ilk giren ilk çıkar) işlemektedir. Backend'den gelen mesajda `task_id` bulunmamaktadır.
- **Etki:** Görevler yanlış sırayla "Tamamlandı" olarak işaretlenmekte, UI'da çalışan ajanlar hatalı gösterilmektedir.

---

## 🎨 4. UI VE GÖRSEL TASARIM KUSURLARI

### 4.1. Tekli Süreç Yanılgısı (State Overwriting)

- **Dosya:** `src/components/terminal/TerminalView.tsx`
- **Sorun:** Sol menüdeki aktif ajanlar listesi `ToolName` (örn: claude) tabanlı bir Map kullanmaktadır.
- **Etki:** 3 farklı Claude sub-task'ı çalışsa bile Map bunları üst üste yazmakta, UI'da sadece 1 tane çalışıyormuş gibi görünmektedir. Çoklu ajan durumu tamamen maskelenmektedir.

### 4.2. Taşmalar ve Kırpılmayan Metinler

- **Dosya:** `src/components/orchestration/KanbanBoard.tsx`
- **Sorun:** Ajanların uzun dosya yolları veya komutları için kelime kırma (`break-words`, `truncate`) CSS sınıfları eksiktir.
- **Etki:** Kutular ekranın dışına taşmakta ve yatay scroll çubukları oluşturmaktadır.

### 4.3. "Sıfır Değişiklik" Yapan Ajanların Gizlenmesi

- **Dosya:** `src/components/review/DiffReview.tsx`
- **Sorun:** Bir alt ajan görevini bitirip hiçbir dosya değiştirmezse, alt kısımdaki aksiyon çubuğu (`files.length > 0` şartından dolayı) yok olmaktadır.
- **Etki:** Kullanıcı boş bir ekranda sıkışıp kalmakta, "İptal Et" veya "Kabul Et" yapamamaktadır.

---

## 🧠 5. UX (KULLANICI DENEYİMİ) ÇIKMAZLARI

### 5.1. Pusuya Düşüren Otomasyon (5 Saniyelik Geri Sayım)

- **Dosya:** `src/components/views/TaskApprovalView.tsx`
- **Sorun:** Görev 5 alt parçaya bölündükten sonra kullanıcının bunları okuması ve doğrulaması için sadece 5 saniye verilmekte, sonra otomatik çalışmaya başlamaktadır.
- **Etki:** Kullanıcı daha planı okuyamadan sistem kendi kendine kod değiştirmeye başlamakta, bu da güvensizlik yaratmaktadır. Otomatik onay varsayılan olmamalıdır.

### 5.2. Ya Hep Ya Hiç (All-or-Nothing) Hata Kurtarma

- **Dosya:** `src/components/views/CodeReviewView.tsx`
- **Sorun:** 5 alt görevden 1'i çöker, 4'ü başarılı olursa, kullanıcıya sadece "Hepsini Kabul Et" veya "Hepsini Reddet" seçenekleri sunulmaktadır.
- **Etki:** "Hatalı görevi tekrar dene" veya "Başarılı olanları al, diğerini atla" gibi granüler seçenekler olmadığı için kullanıcı saatler süren ajan çalışmalarını çöpe atmak zorunda kalmaktadır.

### 5.3. Bilgi Mimarisi ve Teknik Jargon

- **Sorun:** UI, kullanıcıyı sistemin iç mimarisine (DAG Node, Worktree detached) boğmaktadır. Kullanıcı "Adım" ve "Görev" kelimeleri yerine iç sistemin debug loglarını görmektedir.
- **Etki:** Yeni kullanıcılar için öğrenme eğrisi çok diktir. Worktree'ler görev kartlarının bir parçası gibi değil, bağımsız global varlıklar gibi gösterilmektedir.

---

## 🛠️ ACİL AKSİYON TAVSİYESİ (Öncelik Sırası)

1. **Backend DAG Hatasının Çözümü:** `SubTaskDef` içine `id` eklenmeli ve DAG sıralaması düzeltilmeli.
2. **Frontend Onay Hatasının Çözümü:** `activePlan` state mantığı onarılarak UI'dan görev onayı verebilme özelliği aktif edilmeli.
3. **Worktree İzolasyonunun Sağlanması:** Ajanların ana projeyi bozması engellenmeli ve gerçek bir izolasyon/çakışma kontrolü mekanizması kurulmalı.
4. **Concurrency (Kilit) Refactoring:** Ajanların paralel çalışabilmesi için `acquire_tool_slot` darboğazı kaldırılmalı.

5. Frontend Mimari ve React Anti-Pattern'leri (Ajan 1 Raporu)
  Frontend bileşenlerinde tespit edilen en büyük sorun, React'in temel prensiplerinin (declarative state) ihlal edilmesidir.
   - Ölü Kodlar (Dead Code): src/components/review/CodeReviewPanel.tsx ve src/components/ui/resizable.tsx (resizable paneller) dosyaları mükemmel bir şekilde kodlanmış olmalarına rağmen
     projenin hiçbir yerinde kullanılmıyor. Uygulama şu an daha basit olan monolitik CodeReviewView.tsx dosyasını render ediyor.
   - Doğrudan DOM Manipülasyonu: Hover (üzerine gelme) efektleri CSS ile yapılmak yerine onMouseEnter={(e) => { e.currentTarget.style.background = ... }} şeklinde doğrudan DOM manipüle
     edilerek yapılıyor. Bu React mimarisi için bir anti-pattern'dir.
   - Zustand Encapsulation İhlali: src/routes/index.tsx içindeki heartbeat polling mekanizması, Zustand'ın kendi action/mutator'larını kullanmak yerine doğrudan .setState() ile Map'i
     eziyor.
   - Sessizce Yutulan Hatalar: Birçok backend komutu çağrısında .catch(() => {}) kullanılmış (örn: SessionHistory.tsx, ApiKeySettings.tsx). Komutlar başarısız olduğunda UI donuyor ve
     kullanıcıya hiçbir bilgi verilmiyor.

  🔄 2. Frontend State Yönetimi ve Race Condition'lar (Ajan 2 Raporu)

- Kritik Race Condition (Görev Başlatma): useTaskDispatch.ts içerisinde, ajan süreci çok hızlı çökerse (Tauri IPC komutu henüz resolve olmadan exit eventi gelirse), sistem bu kapanma
     eventini kaybediyor. Sonuç: Ajanlar UI'da sonsuza kadar "Running" (çalışıyor) statüsünde takılı (zombie) kalıyor.
- Performans Katili Zustand Map'leri: taskStore.ts içerisinde State olarak ES6 Map kullanılmış. Ancak her 500ms'de bir log geldiğinde tüm Map referansı yenilendiği için, o Map'i
     dinleyen tüm Kanban panosu ve bileşenler gereksiz yere baştan render (re-render) ediliyor. Bu durum ağır UI donmalarına (jank) sebep olur.
- Tekli Listener Kısıtlaması: useProcess.ts içerisindeki output listener'ları aynı anda sadece tek bir bileşenin log okumasına izin veriyor. İkinci bir bileşen aynı ajan logunu
     dinlemeye kalkarsa ilk bileşenin akışı sessizce kesiliyor.

  🛡️ 3. Frontend Lib, Tür Güvenliği ve Parser Hataları (Ajan 3 Raporu)

- Zayıf Hata Tipleri: Tauri backend'i frontend'e yapılandırılmış hata (Enum) dönmek yerine her şeyi String olarak dönüyor. Frontend ise bu hataları yakalamak için kırılgan Regex
     eşleşmeleri (pattern matching) kullanıyor.
- Ajan Loglarını Ayrıştırma (NDJSON) Riski: claude.ts, gemini.ts, codex.ts içindeki parser fonksiyonları try/catch içinde JSON.parse hatalarını tamamen yutarak null dönüyor. Ajanların
     CLI çıktı formatı değişirse (veya bozuk gelirse) UI'a log düşmüyor ve nerede hata olduğunu bulmak imkansızlaşıyor.
- Güvenlik Açığı (XSS Riski): sanitize.ts içerisindeki sanitizeShikiHtml fonksiyonu, zararlı kodları temizlemek için Regex kullanıyor. Regex tabanlı HTML sanitizasyonu kolayca
     atlatılabilir (bypass). DOMPurify gibi gerçek bir DOM parser kullanılmalıdır.

  ⚙️ 4. Backend (Rust/Tauri) Çekirdek ve Bellek Yönetimi (Ajan 4 Raporu)

- Bellek Sızıntısı (Memory Leak) Potansiyeli: state.rs dosyasında ProcessEntry struct'ı ajan çıktılarının tamamını Vec<String> içinde tutuyor. Uzun süren ve binlerce satır çıktı veren
     işlemlerde bu durum backend'in şişmesine neden olacaktır (Kapasite sınırı veya dairesel tampon/VecDeque eksikliği).
- Tehlikeli Sinyal Yönetimi: lib.rs içerisindeki killpg(nix::unistd::Pid::from_raw(proc.pgid), ...) çağrısında, eğer pgid 0 veya 1 gibi bir değere düşerse uygulamanın kendini tamamen
     kapatmasına sebep olabilecek tehlikeli bir sistem çağrısı mevcut.

  🌳 5. Backend Worktree ve Git Motoru (Ajan 7 Raporu)
  WhaleCode'un en büyük vaadi olan "Güvenli Çalışma Alanı", kritik ve sessizce yutulan hatalar barındırıyor:

- Sessiz Git Hataları: conflict.rs içerisinde git merge --abort komutu çalıştırıldığında dönen Result let _ = ile yutuluyor. Eğer bir kilit (lock) nedeniyle iptal işlemi başarısız
     olursa, çalışma ağacı kalıcı olarak "merging" (birleştirme) modunda kalıyor ve tüm sistemi bozuyor.
- TOCTOU Race Condition: Aynı anda iki task başlatılırsa manager.rs içerisindeki klasör temizleme mantığı (.exists() kontrolü ile remove_dir_all() çağrısı arasındaki zaman farkı)
     çökmeye sebep olabilir.
- Path Traversal Riski: git/operations.rs içerisinde frontend'den gelen dosya yolları temizlenmeden/doğrulanmadan (sanitize edilmeden) doğrudan Git Index'ine basılıyor
     (Path::new(path)). Bu, izole klasör dışındaki dosyaların etkilenmesine yol açabilir.

  🤖 6. Backend Süreç (Process) Yönetimi ve Router (Ajan 8 Raporu)

- UI Gecikmesi (Lag): Ajan akışları (stdout) okunurken lines() metodu kullanılıyor. Eğer yapay zeka CLI aracı çıktıları anlık (token-by-token) veriyor ancak satır sonu (newline - \n)
     basmıyorsa, backend tüm veriyi hafızada tutuyor ve UI'a göndermiyor. Ancak satır tamamlanınca UI bir anda yığınla güncelleniyor. Byte chunk'ları halinde okuma (stream) yapılmalı.
- Token/Fiyatlandırma Kaybı: manager.rs içerisindeki NDJSON tarayıcısı ajan kapanırken sadece son 10 satıra bakıyor (saturating_sub(10)). Eğer ajan işlem bitiminde 10 satırdan fazla
     çöp/reklam log basarsa, "result" objesi okunamaz ve token/kullanım istatistikleri kaydedilemez.

  🗺️ 7. Planlama ve Gerçeklik Arasındaki Uçurum (Ajan 9 Raporu)
  Proje belgeleri (ROADMAP.md vs.) ile kod tabanı uyuşmazlıkları tespit edildi:

- Conflict Detection Çalışmıyor: Planlarda "Phase 5 ve 9" ajanların birbirini ezmemesi için Conflict Detection istiyor. Kodda 500 satırlık şahane bir selective_merge (Worktree diff)
     algoritması var, ancak Orchestrator bunu hiçbir zaman çağırmıyor. Ajanlar planı tamamladığı an değişiklikleri kontrolsüzce içeriye basıyor.
- Onay Ekranı Atlanıyor: Kullanıcının, master ajanın hazırladığı task dağıtım planını görebileceği bir "Draft" ekranı planlanmış. Ancak kod doğrudan Phase 2'ye (hemen çalıştırma
     dalgası) geçiyor ve kullanıcıya müdahale şansı tanımıyor.

  ---

  🚀 Acil Aksiyon Planı (Nereden Başlayalım?)
  Eğer bu hataları düzeltmemi isterseniz, düzeltmeye şu 3 kritik konudan birinden başlamamızı şiddetle tavsiye ederim:

   1. Frontend UI Takılmaları ve Race Condition: Zustand yapısını optimize edip ajanların Running statüsünde takılı kalma sorununu çözmek.
   2. Güvenlik İzolasyonu: Codex'in doğrudan ana dizini değiştirmesi ve Worktree API'sindeki sessiz hata yutma (let _ =) problemlerinin düzeltilmesi.
   3. Orchestrator Entegrasyonu: Atıl durumdaki selective_merge çakışma dedektörünün gerçek orkestrasyon hattına (pipeline) bağlanması.
