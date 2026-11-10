# GAZLA! — Kendi sitende yayınla (Cloudflare)

Bu klasör oyunu **tek bir linkten** oynanır hale getirir: siteyi açan kişi takma adını yazar,
**HEMEN OYNA**'ya basar ve açık bir odaya düşer. 2+ kişi olunca 12 sn içinde yarış başlar
(12 kişi dolarsa hemen). Yarış bitince herkes otomatik olarak sıradaki yarışa geçer.
Arkadaşlarla özel oda kurup `siten.com/#oda-xxxx` linkiyle de çağırabilirsin.

Hesap, giriş, claude.ai paylaşımı gerekmez. Oyun dosyası `public/index.html`,
oda sunucusu `src/worker.js` (Worker + Durable Object, WebSocket).

## Kurulum (bir kere)

1. [Node.js](https://nodejs.org) kur (LTS sürüm yeterli).
2. Ücretsiz bir [Cloudflare hesabı](https://dash.cloudflare.com/sign-up) aç.
3. Bu klasörde terminal aç:
   ```bash
   npm install
   npx wrangler login      # tarayıcıda Cloudflare'e izin ver
   npx wrangler deploy
   ```
4. Çıktıda `https://gazla.<hesabın>.workers.dev` gibi bir adres görürsün. Oyun bu kadar — linki paylaş.

## Kendi alan adını bağlamak

Alan adın Cloudflare'de ise: **Dashboard → Workers & Pages → gazla → Settings → Domains & Routes → Add → Custom domain**
ve `oyun.alanadin.com` gibi bir adres yaz. SSL otomatik gelir.

## Yerelde denemek

```bash
npx wrangler dev
```
Sonra `http://localhost:8787` adresini iki farklı tarayıcı penceresinde aç.

## Güncellemek

Oyunun yeni sürümünde sadece `public/index.html` dosyasını değiştirip tekrar `npx wrangler deploy` yap.

## Maliyet notu

Durable Objects, Workers Free planda (SQLite tabanlı) kullanılabiliyor. Ücretsiz planda günlük
**100.000 istek** sınırı var; gelen WebSocket mesajları 20'de 1 istek sayılıyor.
Oyun yarış sırasında oyuncu başına saniyede 20 güncelleme gönderir:

| Odadaki oyuncu | Ücretsiz kotayla günlük yaklaşık yarış süresi |
|---|---|
| 4 | ~7 saat |
| 12 | ~2,3 saat |

Lobide beklerken neredeyse hiç mesaj gitmez ve oda "uyku" moduna geçebilir (WebSocket Hibernation).
Kota biterse online kısım o gün için durur; yoğun kullanımda Workers Paid ($5/ay) planı yeterli olur.

## Sınırlar

- Oda başına en fazla 12 oyuncu, mesaj başına 8 KB, oyuncu başına saniyede 60 mesaj.
- Hızlı oyun odaları `hzl01` … `hzl30`; yarışı süren odaya yeni gelen, bir sonraki boş odaya yönlenir.
- 3B kütüphanesi (three.js) jsDelivr CDN'den yüklenir.
