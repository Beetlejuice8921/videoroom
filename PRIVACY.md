# Videoroom — политика конфиденциальности / Privacy policy

*Действует с 6 октября 2026 / Effective October 6, 2026*

## По-русски

Videoroom не собирает, не продаёт и не передаёт персональные данные. У расширения
нет своего сервера, аналитики и рекламы.

**Что хранится и где**
- Ваши комнаты (списки видео, сдвиги, расстановка камер) и настройки хранятся
  только в вашем браузере (`chrome.storage.local`).
- Для синхронизации по звуку расширение анализирует звук видео прямо в браузере
  и сохраняет там же компактную «огибающую громкости» (~14 КБ на 18 минут видео).
  Звук никуда не отправляется.

**С какими сайтами расширение связывается**
- **youtube.com** — показывает полосу ракурсов под плеером, переключает видео,
  ищет другие ракурсы через обычный поиск YouTube. Запросы идут от вашего
  браузера, как при обычном использовании сайта.
- **raw.githubusercontent.com** — раз в 30 минут читает публичный реестр общих
  комнат ([videoroom-rooms](https://github.com/Beetlejuice8921/videoroom-rooms)).
  Передаётся только сам запрос файла; GitHub видит ваш IP-адрес, как при открытии
  любой страницы. Отключается в настройках расширения.
- **beetlejuice8921.github.io** — страница кинозала. Список видео комнаты
  передаётся в адресе страницы (после `#`), который не отправляется на сервер.
- **youtube.com/embed** — встроенные плееры в кинозале работают по правилам YouTube.

**Публикация комнаты** происходит только по вашей команде («🌐 Поделиться»):
открывается заявка на GitHub, которую вы отправляете сами. Она публична и
подписана вашим аккаунтом GitHub.

**Удаление данных:** удалите комнаты в меню расширения или удалите расширение —
вместе с ним удаляются все его данные.

Вопросы: [github.com/Beetlejuice8921/videoroom/issues](https://github.com/Beetlejuice8921/videoroom/issues)

## In English

Videoroom does not collect, sell or share personal data. It has no server of its
own, no analytics and no ads.

**What is stored and where**
- Your rooms (video lists, offsets, camera layout) and settings are stored only
  in your browser (`chrome.storage.local`).
- Audio sync analyses the videos' sound locally in the browser and keeps a
  compact loudness envelope there (~14 KB per 18 minutes of video). Audio never
  leaves your computer.

**Which sites the extension talks to**
- **youtube.com** — shows the camera strip under the player, switches videos and
  searches for other angles using YouTube's regular search, from your browser.
- **raw.githubusercontent.com** — every 30 minutes reads the public shared-rooms
  registry ([videoroom-rooms](https://github.com/Beetlejuice8921/videoroom-rooms)).
  Only the file request is sent; GitHub sees your IP address as with any web page.
  Can be turned off in the extension settings.
- **beetlejuice8921.github.io** — the cinema page. The room's video list travels
  in the URL fragment (after `#`), which browsers do not send to the server.
- **youtube.com/embed** — embedded players in the cinema follow YouTube's terms.

**Publishing a room** happens only when you choose "🌐 Share": it opens a GitHub
issue that you submit yourself; it is public and signed by your GitHub account.

**Deleting data:** delete rooms in the extension menu or uninstall the extension,
which removes all of its data.

Contact: [github.com/Beetlejuice8921/videoroom/issues](https://github.com/Beetlejuice8921/videoroom/issues)
