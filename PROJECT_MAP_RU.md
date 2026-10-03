# Карта проекта Elka

Краткая карта модулей и подсказки, где менять поведение приложения.

## Точки входа

- `backend/cmd/elka-desktop/main.go` — запуск Wails, регистрация Go-сервисов, открытие SQLite и выбор активной папки vault. Цвет нативного окна берётся из `appBackgroundColor`, поэтому светлая тема не начинается с чёрного кадра.
- `frontend/src/App.tsx` — React-корень: настройки языка, обработка событий SSH/синхронизации и подключение страниц.
- `frontend/index.html` — статический splash-экран с инлайн-стилями и скриптом: рисуется первым кадром, пока грузится бандл, и берёт палитру из кэша `localStorage` (его пишет `applyAppAppearance`). Закрывается из `frontend/src/lib/splash.ts` после загрузки настроек.
- `Taskfile.yml` — команды сборки проекта; платформа выбирается через `build/{darwin,windows,linux}/Taskfile.yml`.
- `build-macos-in-docker.sh` — сборка macOS-приложения в Docker.

## Интерфейс

- `frontend/src/components/layout/Sidebar.tsx` — боковая навигация и подсказки разделов. Кнопка сворачивания стоит первым пунктом самой панели: в свёрнутом виде остаётся узкая колонка только с ней, поэтому вернуть панель можно в любой момент. Если переключатель выключен в настройках, панель по инварианту `uiStore` всегда открыта.
- `frontend/src/components/layout/TitleBar.tsx` — верхние вкладки терминалов, вкладка разделённого пространства и кнопка новой вкладки.
- `frontend/src/lib/sidebar.ts` — ширина боковой панели, ширина её свёрнутого вида и длительность анимации. Панель, зеркальная полоса в `TitleBar.tsx` и перетаскивание окна берут оттуда свои размеры, а `store/uiStore.ts` держит флаг `isSidebarTransitioning` на время движения: панель прячет подсказки разделов (`overflow-hidden`), а терминалы ждут конца анимации. Переход описан классом `.sidebar-transition` в `assets/main.css`.
- `frontend/src/components/layout/TerminalTab.tsx` и `SplitWorkspaceTab.tsx` — обычная вкладка SSH и вкладка split-пространства; контекстные меню и перетаскивание вкладок.
- `frontend/src/components/layout/HostViewPicker.tsx` — меню выбора карточек, списка или дерева.
- `frontend/src/components/views/HostsPage.tsx` и `HostModal.tsx` — список, группы и форма хоста, включая JumpHost и port forwarding.
- `frontend/src/components/views/GroupsPage.tsx` и `GroupModal.tsx` — управление группами и показ их хостов.
- `frontend/src/components/views/CredentialsPage.tsx` и `CredentialModal.tsx` — сохранённые комбинированные учётные данные.
- `frontend/src/components/views/SettingsPage.tsx` — настройки отображения и расположения vault.
- `frontend/src/components/views/LockScreen.tsx` — первый запуск, выбор vault, регистрация и разблокировка.
- `frontend/src/store/uiStore.ts` и `authStore.ts` — активный раздел/режим отображения и состояние авторизации.
- `frontend/src/assets/main.css` — цвета и общие стили приложения, включая прокрутку.
- `frontend/public/locales/{en,ru}/` — подписи интерфейса на английском и русском.

## Терминалы и подключения

- `frontend/src/store/sessionStore.ts` — SSH-сессии, верхний порядок вкладок и дерево split-пространства. Оно хранится в памяти приложения, поэтому остаётся при переключении разделов, но не является постоянной настройкой vault.
- `frontend/src/components/terminal/TerminalStack.tsx` — размещение split-панелей и изменение их размеров.
- `frontend/src/components/terminal/TerminalInstance.tsx` — xterm, ввод/вывод SSH, подгонка размеров, drag-and-drop и действия панели. Пока идёт SSH-хендшейк, поверх терминала показывается лоадер подключения, а при ошибке терминал всё равно подгоняется под размер, чтобы текст ошибки был виден. Пока сворачивается боковая панель, подгонка по `ResizeObserver` пропускается: кадры анимации не перерисовывают экран, а одна подгонка ждёт конца движения.
- `frontend/src/lib/sshConnection.ts` — разрешение учётных данных хоста/группы, ключей, цепочки JumpHost и port forwards для подключения.
- `backend/internal/services/ssh/ssh.go` — SSH-соединение, цепочка промежуточных серверов и локальная/удалённая переадресация портов.

## Данные и безопасность

- `backend/internal/services/blob/models.go` — модели хостов, групп, ключей, учётных данных и port forwards.
- `backend/internal/services/blob/wrappers.go` — Go-сервисы CRUD для этих моделей.
- `backend/internal/services/blob/store.go` — общая сериализация и шифрование записей перед сохранением.
- Хосты, группы, ключи и учётные данные лежат в таблице `encrypted_blobs`; записи синхронизируются в зашифрованном виде.
- `backend/internal/services/settings/settings.go` — `settings.json`, режимы отображения и переключение/перемещение vault.
- `backend/internal/migration/` — схема локальной SQLite-базы.
- `backend/internal/services/sync/` и `backend/internal/api/` — синхронизация и HTTP API-клиент.

## Типовые изменения

- Добавить поле хоста или группы: изменить модель в `backend/internal/services/blob/models.go`, UI-форму и оба locale-файла; затем обновить Wails bindings.
- Изменить способ подключения: форма `HostModal.tsx` → сборка конфигурации в `sshConnection.ts` → реализация в `backend/internal/services/ssh/ssh.go`.
- Изменить разделённый экран: действия/дерево — `sessionStore.ts`, верхние вкладки — `TitleBar.tsx`, размеры и drop targets — `TerminalStack.tsx` / `TerminalInstance.tsx`.
- Добавить настройку: `AppSettings` и `SettingsService` в `settings.go`, UI в `SettingsPage.tsx`, загрузка при запуске в `App.tsx`, подписи в `locales`.

Bindings генерируются, их не следует редактировать вручную. Команда проекта находится в `build/Taskfile.yml`, задача `generate:bindings`.

Основные проверки: `go test ./backend/internal/services/... ./backend/cmd/elka-desktop/...`, `go vet ./backend/internal/services/...` и frontend production build (`pnpm run build` из `frontend/`).
