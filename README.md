# Unicornlu Not Defterim 🦄🧱

Lego tuğlalarından oluşan kişisel not defteri. iPhone, Windows ve Mac'te çalışır, notların tüm cihazlarında eşitlenir.

- **Tuğla notlar:** her not bir Lego tuğlası; taban plakasına oturur. Renk, boyut, sabitleme.
- **Liste notları:** işaretlenebilir maddeler, hepsi bitince konfeti.
- **Çevrimdışı çalışır:** internet yokken de yazarsın; bağlantı gelince otomatik eşitlenir.
- **Hiçbir not sessizce ezilmez:** iki cihaz aynı notu aynı anda değiştirirse ikisi de saklanır ("çakışma kopyası").
- **Çöp kutusu:** silinen notlar 30 gün bekler. Geçmişin tamamı GitHub'da commit olarak durur.

## Nasıl çalışır?

```
Cihaz (tarayıcı / ana ekran uygulaması)
   │  yazarken anında yerel kayıt (IndexedDB)
   │  birkaç saniye sonra
   ▼
GitHub özel veri deposu  ──►  notes/<id>.json  (her not bir dosya)
   ▲
   │  30 sn'de bir ve uygulama öne gelince kontrol
Diğer cihazlar
```

Sunucu yok, hesap yok: uygulama statik dosyalardır (GitHub Pages), veriler **senin özel GitHub deponda** durur.

## Kurulum (bir kez)

1. **Veri deposu:** GitHub'da *özel (private)* bir depo oluştur, örn. `unicornlu-notlar`. (README ile başlat.)
2. **Anahtar:** <https://github.com/settings/personal-access-tokens/new>
   - Token name: `Not Defterim`
   - Expiration: `No expiration`
   - Repository access: **Only select repositories** → veri deposunu seç
   - Permissions → Repository permissions → **Contents: Read and write**
   - **Generate token** → `github_pat_…` kodunu kopyala
3. Uygulamayı aç → *Eşitlemeyi kur* → anahtarı yapıştır → *Bağlan*.
4. Ayarlar → **Kurulum kodunu kopyala** → diğer cihazlarda açılış ekranına yapıştır. Bitti.

### iPhone
Safari'de aç → Paylaş → **Ana Ekrana Ekle**. Kurulum kodunu **ana ekrandaki uygulamada** yapıştır (Safari ile ana ekran uygulaması ayrı depolama kullanır).

### Windows / Mac
Chrome veya Edge: adres çubuğundaki *Yükle* simgesi. Safari (Mac): Dosya → Dock'a Ekle.

## Yayınlama (GitHub Pages)

Uygulama dosyaları herkese açık bir sitede durmalıdır, notların ise **özel** depoda. Bu yüzden:

1. Bu depoyu **public** yap (içinde yalnızca uygulama kodu var; notlar ayrı özel depoda): Settings → Danger Zone → *Change visibility*.
2. Settings → Pages → *Deploy from a branch* → `main` / `(root)` → Save.
3. Adres: `https://<kullanıcı>.github.io/unicornlu-not-defterim/`

## Gizlilik ve güvenlik

- Notlar yalnızca **özel veri deponda** durur; uygulama sitesinde not yoktur.
- Anahtar yalnızca o depoya erişir (Contents: Read and write). Bu cihazın tarayıcı depolamasında tutulur.
- **Kurulum kodu anahtarını içerir.** Yalnızca kendi cihazlarına gönder, başkasıyla paylaşma.
- Silinen notların eski sürümleri GitHub commit geçmişinde kalır. Commit mesajlarında not başlığı yazılmaz.
- Anahtarın sızdığından şüphelenirsen GitHub → Settings → Developer settings → Personal access tokens bölümünden sil, yenisini oluştur.

## Kısayollar (bilgisayarda)

| Tuş | İş |
|---|---|
| `n` | Yeni not |
| `l` | Yeni liste |
| `/` | Ara |
| `Esc` | Kapat |
| `Ctrl/Cmd + Enter` | Notu kapat |

## Geliştirme

Derleme adımı yok; düz HTML/CSS/JS.

```bash
node --test tests/*.test.mjs        # eşitleme motoru testleri (sahte GitHub ile)
npx serve .                         # ya da herhangi bir statik sunucu
```

```
index.html          kabuk
css/app.css         tüm stil
js/store.js         yerel depo (IndexedDB) + not modeli
js/sync.js          GitHub eşitleme motoru
js/app.js           arayüz
js/palette.js       tuğla renkleri
js/fx.js            animasyon / ses / konfeti
sw.js               çevrimdışı önbellek
tests/              eşitleme testleri + sahte GitHub
```

Yazı tipi: [Fredoka](https://fonts.google.com/specimen/Fredoka) (SIL Open Font License).
