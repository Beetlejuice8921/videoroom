# Chrome Web Store — карточка и ответы для проверки

Пакет: `bash tools/package.sh` → `dist/videoroom-<версия>.zip`.
Скриншоты: `store/screenshots/` (1280×800). Иконка магазина: `icons/icon128.png`.

## Основное

| Поле | Значение |
|---|---|
| Категория | Развлечения (Entertainment) |
| Язык по умолчанию | Русский; есть английская локализация |
| Сайт | https://github.com/Beetlejuice8921/videoroom |
| Поддержка | https://github.com/Beetlejuice8921/videoroom/issues |
| Политика конфиденциальности | https://github.com/Beetlejuice8921/videoroom/blob/main/PRIVACY.md |

## Подробное описание (RU)

Videoroom превращает несколько видео одного события в «комнату» с разными ракурсами.
Концерт, баттл, матч, выступление: люди снимают его с разных мест и выкладывают
на YouTube. Videoroom собирает эти видео, выравнивает по времени и даёт
переключаться между камерами, не теряя момент.

• Полоса ракурсов прямо под плеером YouTube. Клавиши 1–9, Q/E и WASD
  (ближе к сцене, дальше, левее, правее).
• Кинозал: все ближайшие ракурсы загружены заранее, переключение мгновенное.
  Непрерывный звук с одной камеры, подстройка сдвига по 0,1 с.
• Синхронизация по звуку: расширение само находит, на сколько секунд сдвинуты
  записи друг относительно друга.
• Поиск других ракурсов события на YouTube с проверкой по звуку: чужие видео
  отсеиваются, найденные добавляются сразу со сдвигом.
• Карта площадки: расставьте камеры и сцену так, как они стояли в зале.
• Общие комнаты: делитесь своими комнатами с другими зрителями.

Без регистрации, без серверов, без рекламы. Открытый исходный код (MIT):
https://github.com/Beetlejuice8921/videoroom

## Detailed description (EN)

Videoroom turns several videos of the same event into a "room" of camera angles.
Concerts, dance battles, matches, shows: people film them from different spots
and upload to YouTube. Videoroom gathers those videos, lines them up in time and
lets you switch cameras without losing the moment.

• Camera strip right under the YouTube player. Keys 1–9, Q/E and WASD
  (closer to the stage, further, left, right).
• Cinema mode: nearby angles are preloaded, so switching is instant. Continuous
  audio from one camera, offset fine-tuning in 0.1 s steps.
• Audio sync: finds by itself how many seconds the recordings are apart.
• Finds other angles of the event on YouTube and verifies them by audio: other
  events are filtered out, matches are added together with their offset.
• Venue map: place the cameras and the stage the way they stood.
• Shared rooms: share your rooms with other viewers.

No sign-up, no servers, no ads. Open source (MIT):
https://github.com/Beetlejuice8921/videoroom

## Единственное назначение (single purpose)

Просмотр видео одного события на YouTube с разных ракурсов: объединение таких видео
в комнату, их синхронизация и переключение между ними.

## Обоснование разрешений

| Разрешение | Зачем |
|---|---|
| `storage` | Хранить комнаты пользователя, настройки и кэш звуковых огибающих локально. |
| `activeTab` | Узнать адрес открытого видео YouTube, когда пользователь открывает меню расширения, чтобы предложить создать для него комнату. |
| Хост `raw.githubusercontent.com/Beetlejuice8921/videoroom-rooms/*` | Читать публичный реестр общих комнат (только чтение JSON, без передачи данных пользователя). |
| Content script на `www.youtube.com` | Показ полосы ракурсов под плеером, переключение видео в плеере, поиск других ракурсов, анализ звука для синхронизации. |
| Content script на `beetlejuice8921.github.io/videoroom-cinema/*` | Страница кинозала проекта: сохранение сдвигов и расстановки камер в хранилище расширения. |
| Удалённый код | Не используется: весь исполняемый код в пакете. С GitHub загружаются только данные (JSON реестра) и отдельная веб-страница кинозала. |

## Использование данных (анкета «Privacy practices»)

- Сбор данных пользователя: **нет** ни по одной категории (ПДн, здоровье, финансы,
  аутентификация, личные сообщения, местоположение, история браузера, активность,
  контент сайтов).
- Подтверждения: данные не продаются третьим лицам; не используются в целях, не
  связанных с единственным назначением; не используются для оценки кредитоспособности.
