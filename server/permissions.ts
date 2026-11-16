export const ALL = '*';
export const CORE = 'core';
export const PUBLIC = 'public';

export interface CatalogItem {
  key: string;
  label: string;
  hint: string;
}

export const CATALOG: Array<{ group: string; items: CatalogItem[] }> = [
  {
    group: 'Календарь и бригады',
    items: [
      { key: 'calendar.view', label: 'Видеть календарь, бригады и задания', hint: 'главная страница; без этого права разделы «Все АПК», «Отчёты» и др. работают, но календаря нет' },
      { key: 'calendar.edit', label: 'Создавать, менять, переносить и удалять задания и бригады', hint: 'в том числе командировки и перенос на другой день' },
      { key: 'calendar.print', label: 'Печатать план-наряд и выгружать план дня', hint: 'бланк план-наряда, Excel и KML для карт' },
      { key: 'people.edit', label: 'Менять персонал', hint: 'добавлять, править и удалять людей (монтёров, водителей и др.)' },
      { key: 'plans.edit', label: 'Планы выездов', hint: 'собирать планы, группировать, превращать в задания' },
    ],
  },
  {
    group: 'Комплексы («Все АПК»)',
    items: [
      { key: 'points.view', label: 'Видеть раздел «Все АПК»', hint: 'список, карточки, карта, подгруппы' },
      { key: 'points.edit', label: 'Создавать, менять и удалять комплексы', hint: 'а также категории, статусы, типы выездов, подгруппы и объединение дублей' },
      { key: 'points.secrets', label: 'Видеть и копировать логины и пароли комплексов', hint: 'самые чувствительные сведения: давайте только тем, кому они нужны для работы' },
      { key: 'points.network', label: 'Видеть IP-адрес и порт, проверять связь', hint: 'в том числе выгрузка SIM с IP' },
      { key: 'points.import', label: 'Загружать комплексы и SIM из Excel и «Паутины»', hint: '' },
      { key: 'points.export', label: 'Выгружать комплексы и SIM в Excel', hint: '' },
      { key: 'check.use', label: 'Вкладка «Проверка»', hint: 'список номеров → сведения → Excel' },
    ],
  },
  {
    group: 'Отчёты, мониторинг и фото',
    items: [
      { key: 'reports.view', label: 'Видеть раздел «Отчёты» и выгрузки', hint: '' },
      { key: 'reports.edit', label: 'Вносить и править отчёты о выездах', hint: 'в том числе загрузка из Яндекс Форм и журнал выездов' },
      { key: 'reports.builder', label: 'Конструктор отчётов и шаблоны', hint: '' },
      { key: 'monitoring.view', label: 'Видеть раздел «Мониторинг»', hint: 'итоги по комплексам, кто сейчас на комплексе' },
      { key: 'monitoring.manage', label: 'Убирать итоги и рабочие сессии, освобождать комплекс, отправлять на демонтаж', hint: '' },
      { key: 'photos.view', label: 'Смотреть фото комплексов', hint: '' },
      { key: 'photos.upload', label: 'Добавлять фото вручную', hint: '' },
      { key: 'photos.delete', label: 'Удалять фото', hint: '' },
      { key: 'stats.view', label: 'Видеть раздел «Статистика»', hint: 'в том числе вкладку «Счётчики» (числа по выбранным условиям)' },
      { key: 'stats.counters', label: 'Создавать и менять счётчики в «Статистике»', hint: 'название и условия счётчиков; видят счётчики все, кто видит «Статистику»' },
    ],
  },
  {
    group: 'Работа с монтёрами',
    items: [
      { key: 'chat.view', label: 'Читать чат с монтёрами', hint: '' },
      { key: 'chat.use', label: 'Писать монтёрам в чате', hint: '' },
      { key: 'chat.broadcast', label: 'Массовая рассылка монтёрам в бота', hint: 'одно сообщение (текст и фото) всем, по условиям или по выбору; видно, кому дошло, а кому нет' },
      { key: 'notifications.view', label: 'Видеть раздел «Уведомления»', hint: 'проверки, ошибки данных, заявки монтёров' },
      { key: 'notifications.resolve', label: 'Решать заявки монтёров и ошибки данных', hint: 'проверка, демонтаж, доступ, связки SIM, заявки на вступление в бота' },
      { key: 'maps.manage', label: 'Карты бригад и «живые карты» (Яндекс)', hint: '' },
      { key: 'bot.toggle', label: 'Включать и выключать бота VK', hint: '' },
    ],
  },
  {
    group: 'Склад',
    items: [
      { key: 'warehouse.view', label: 'Видеть раздел «Склад»', hint: 'оборудование, SIM, солнечные панели' },
      { key: 'warehouse.edit', label: 'Операции со складом', hint: 'приём, выдача, установка, снятие, статусы, импорт' },
    ],
  },
  {
    group: 'Отсутствия',
    items: [
      { key: 'absences.view', label: 'Видеть раздел «Отсутствия»', hint: '' },
      { key: 'absences.edit', label: 'Вносить и править отсутствия', hint: '' },
    ],
  },
  {
    group: 'ИИ-помощник',
    items: [
      { key: 'assistant.use', label: 'Пользоваться ИИ-помощником', hint: 'помощник видит только те данные, на которые у роли есть права' },
    ],
  },
  {
    group: 'Администрирование',
    items: [
      { key: 'admin.users', label: 'Пользователи и роли', hint: 'создание и удаление пользователей, пароли, создание и правка ролей. Высокий риск: позволяет раздавать права (не больше, чем есть у самого)' },
      { key: 'admin.settings', label: 'Настройки системы', hint: 'ИИ, погода, Яндекс-аккаунт и Формы, сетевой диск с фото' },
      { key: 'admin.system', label: '«Состояние системы»', hint: '' },
      { key: 'admin.backup', label: 'Копия базы: скачать и восстановить', hint: 'в копии — вся база целиком' },
      { key: 'admin.keys', label: 'Ключ шифрования', hint: '' },
      { key: 'admin.security', label: 'Журнал безопасности', hint: '' },
    ],
  },
];

export const LABELS: Record<string, string> = {};
export const ALL_KEYS: string[] = [];
for (const g of CATALOG) {
  for (const item of g.items) {
    LABELS[item.key] = item.label;
    ALL_KEYS.push(item.key);
  }
}

export const IMPLIES: Record<string, string[]> = {
  'calendar.edit': ['calendar.view'],
  'calendar.print': ['calendar.view'],
  'people.edit': ['calendar.view'],
  'plans.edit': ['calendar.view'],
  'points.edit': ['points.view'],
  'points.import': ['points.view'],
  'points.export': ['points.view'],
  'reports.edit': ['reports.view'],
  'reports.builder': ['reports.view'],
  'monitoring.manage': ['monitoring.view'],
  'photos.upload': ['photos.view'],
  'photos.delete': ['photos.view'],
  'stats.counters': ['stats.view'],
  'chat.use': ['chat.view'],
  'chat.broadcast': ['chat.use', 'chat.view'],
  'notifications.resolve': ['notifications.view'],
  'warehouse.edit': ['warehouse.view'],
  'absences.edit': ['absences.view'],
  'admin.users': ['calendar.view'],
  'admin.settings': ['calendar.view'],
  'admin.system': ['calendar.view'],
  'admin.backup': ['calendar.view'],
  'admin.keys': ['calendar.view'],
  'admin.security': ['calendar.view'],
};

export const CORE_READ = new Set([
  'calendar.view',
  'points.view',
  'reports.view',
  'monitoring.view',
  'notifications.view',
  'stats.view',
  'warehouse.view',
  'check.use',
  'photos.view',
  'chat.view',
  'maps.manage',
]);

export const PAGES: Array<[string, string[]]> = [
  ['/', ['calendar.view']],
  ['/apk', ['points.view', 'check.use']],
  ['/warehouse', ['warehouse.view']],
  ['/reports', ['reports.view']],
  ['/monitoring', ['monitoring.view']],
  ['/notifications', ['notifications.view']],
  ['/stats', ['stats.view']],
  ['/absences', ['absences.view']],
  ['/assistant', ['assistant.use']],
];

const OPERATOR_PERMS = [
  'calendar.view', 'calendar.edit', 'calendar.print', 'people.edit', 'plans.edit',
  'points.view', 'points.edit', 'points.secrets', 'points.network', 'points.import', 'points.export', 'check.use',
  'reports.view', 'reports.edit', 'reports.builder', 'monitoring.view', 'monitoring.manage',
  'photos.view', 'photos.upload', 'photos.delete', 'stats.view', 'stats.counters',
  'chat.view', 'chat.use', 'chat.broadcast', 'notifications.view', 'notifications.resolve',
  'maps.manage', 'bot.toggle', 'absences.view', 'absences.edit', 'assistant.use',
];

export const BUILTIN_ROLES: Record<string, { name: string; description: string; perms: string[] }> = {
  admin: {
    name: 'Администратор',
    description: 'Всё: все разделы, настройки, пользователи и роли, копии базы, ключ шифрования, журнал безопасности.',
    perms: [ALL],
  },
  user: {
    name: 'Оператор',
    description: 'Рабочая роль диспетчера: календарь, комплексы (с логинами и паролями), отчёты, мониторинг, уведомления, чат, статистика, отсутствия. Без администрирования и склада.',
    perms: OPERATOR_PERMS,
  },
  warehouse: {
    name: 'Склад',
    description: 'Учёт оборудования: страница «Склад», операции со складом, смена статуса комплекса при приёме и выдаче; IP комплексов видит, пароли — нет.',
    perms: ['warehouse.view', 'warehouse.edit', 'points.network', 'assistant.use'],
  },
  viewer: {
    name: 'Только просмотр',
    description: 'Читает календарь, комплексы (без IP и паролей), отчёты, мониторинг, фото, уведомления и чат; ничего не меняет.',
    perms: [
      'calendar.view', 'points.view', 'points.export', 'check.use', 'reports.view',
      'monitoring.view', 'photos.view', 'chat.view', 'notifications.view', 'absences.view', 'assistant.use',
    ],
  },
  absences: {
    name: 'Отсутствия',
    description: 'Только раздел «Отсутствия»: смотреть и вносить отсутствия сотрудников; остального не видит.',
    perms: ['absences.view', 'absences.edit', 'assistant.use'],
  },
};

export function expandPerms(perms: string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const p of perms || []) {
    if (p === ALL) return [ALL];
    if (p in LABELS) {
      out.add(p);
      for (const imp of IMPLIES[p] || []) out.add(imp);
    }
  }
  return Array.from(out).sort();
}

export function hasPerm(perms: Iterable<string> | null | undefined, key: string): boolean {
  const s = new Set(perms || []);
  return s.has(ALL) || s.has(key);
}

export function hasAnyPerm(perms: Iterable<string> | null | undefined, keys: Iterable<string>): boolean {
  const s = new Set(perms || []);
  if (s.has(ALL)) return true;
  for (const k of keys) if (s.has(k)) return true;
  return false;
}

export function isSubsetPerms(wanted: Iterable<string>, granted: Iterable<string>): boolean {
  const g = new Set(granted || []);
  if (g.has(ALL)) return true;
  const w = new Set(wanted || []);
  if (w.has(ALL)) return false;
  for (const k of w) if (!g.has(k)) return false;
  return true;
}

export function secretsOk(perms: Iterable<string>): boolean {
  return hasPerm(perms, 'points.secrets');
}

export function networkOk(perms: Iterable<string>): boolean {
  return hasPerm(perms, 'points.network');
}

export function landingPage(perms: Iterable<string>): string {
  for (const [pagePath, keys] of PAGES) {
    if (hasAnyPerm(perms, keys)) return pagePath;
  }
  return '/no-access';
}

export function needText(need: string[]): string {
  const labels = need.map((k) => {
    if (k === ALL) return 'права администратора';
    if (k === CORE) return 'доступ хотя бы к одному разделу';
    return LABELS[k] || k;
  });
  return labels.join(' или ');
}

const G = new Set(['GET', 'HEAD']);
const W = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Rule = [Set<string> | null, RegExp, string[], string];

export const RULES: Rule[] = [
  [null, /^\/api\/auth(\/|$)/, [PUBLIC], 'вход и смена своего пароля'],
  [null, /^\/api\/security\/policy$/, [PUBLIC], 'политика паролей для форм'],
  [G, /^\/api\/weather$/, [PUBLIC], 'прогноз для фона'],
  [null, /^\/api\/games(\/|$)/, [PUBLIC], 'игры: свои результаты и таблица рекордов'],
  [null, /^\/api\/admin(\/|$)/, ['admin.users'], 'пользователи и роли'],
  [null, /^\/api\/backup(\/|$)/, ['admin.backup'], 'копия базы'],
  [null, /^\/api\/encryption(\/|$)/, ['admin.keys'], 'ключ шифрования'],
  [null, /^\/api\/security\//, ['admin.security'], 'журнал безопасности'],
  [null, /^\/api\/system(\/|$)/, ['admin.system'], 'состояние системы'],
  [null, /^\/api\/(ai|ai-agents|forms-auto|photo-storage\/(config|flush|index|marker|migrate|scan|test)|weather\/(settings|test))(\/|$)/, ['admin.settings'], 'настройки интеграций и ИИ'],
  [null, /^\/api\/yandex-robot\/(settings|view|audio|logout|netcheck|jobs\/[^/]+\/shot)/, ['admin.settings'], 'аккаунт робота Яндекса'],
  [null, /^\/api\/yandex-robot(\/|$)/, ['maps.manage'], 'карты бригад'],
  [G, /^\/api\/photo-storage$/, [CORE], 'состояние сетевого диска'],
  [G, /^\/api\/bot-settings$/, [CORE], 'состояние бота'],
  [W, /^\/api\/bot-settings$/, ['bot.toggle'], 'включить или выключить бота'],
  [G, /^\/api\/state$/, [CORE], 'состояние календаря'],
  [W, /^\/api\/state$/, ['calendar.edit'], 'сохранение календаря'],
  [G, /^\/api\/crews(\/|$)/, [CORE], 'бригады'],
  [W, /^\/api\/crews(\/|$)/, ['calendar.edit'], 'бригады: изменения'],
  [W, /^\/api\/people\/\d+\/absences(\/|$)/, ['people.edit'], 'отсутствия человека'],
  [G, /^\/api\/people\/\d+\/erase-preview$/, ['people.edit'], 'предпросмотр удаления сотрудника'],
  [G, /^\/api\/people\/\d+\/tasks$/, ['people.edit'], 'задания сотрудника'],
  [G, /^\/api\/people(\/|$)/, [CORE], 'персонал'],
  [W, /^\/api\/people(\/|$)/, ['people.edit'], 'персонал: изменения'],
  [G, /^\/api\/absences(\/|$)/, ['absences.view'], 'отсутствия'],
  [W, /^\/api\/absences(\/|$)/, ['absences.edit'], 'отсутствия: изменения'],
  [null, /^\/plan-print(\/|$)/, ['calendar.print'], 'печать план-наряда'],
  [G, /^\/api\/kml(\/|$)/, ['calendar.print', 'maps.manage', 'points.export'], 'KML для карт'],
  [G, /^\/api\/points\/[^/]+\/(ping|check-port)$/, ['points.network'], 'проверка связи'],
  [W, /^\/api\/points\/resolve$/, ['calendar.edit', 'points.import', 'plans.edit', 'maps.manage'], 'разбор меток карты'],
  [W, /^\/api\/points\/assign$/, ['calendar.edit', 'plans.edit'], 'комплексы → задания бригады'],
  [W, /^\/api\/points\/[^/]+\/status$/, ['points.edit', 'warehouse.edit'], 'статус комплекса'],
  [G, /^\/api\/points\/duplicates$/, ['points.edit'], 'дубли комплексов'],
  [G, /^\/api\/points(\/|$)/, [CORE], 'справочник комплексов'],
  [W, /^\/api\/points(\/|$)/, ['points.edit'], 'комплексы: изменения'],
  [G, /^\/api\/(point-categories|point-statuses|work-types)(\/|$)/, [CORE], 'справочники'],
  [W, /^\/api\/(point-categories|point-statuses|work-types)(\/|$)/, ['points.edit'], 'справочники: изменения'],
  [G, /^\/api\/point-plans(\/|$)/, [CORE], 'планы выездов'],
  [W, /^\/api\/point-plans(\/|$)/, ['plans.edit', 'calendar.edit'], 'планы выездов: изменения'],
  [G, /^\/api\/(point-card|point-files)(\/|$)/, ['points.view', 'calendar.view', 'check.use'], 'карточка комплекса'],
  [W, /^\/api\/point-files(\/|$)/, ['points.edit'], 'файлы при комплексе'],
  [G, /^\/api\/apk-groups(\/|$)/, ['points.view'], 'подгруппы'],
  [W, /^\/api\/apk-groups(\/|$)/, ['points.edit'], 'подгруппы: изменения'],
  [G, /^\/api\/excel\/(plan|yandex)(\/|-points|$)/, ['calendar.print', 'maps.manage'], 'выгрузки для календаря и карт'],
  [G, /^\/api\/excel\/period-report$/, ['reports.view'], 'отчёт за период'],
  [G, /^\/api\/excel\/sim-ip-export$/, ['points.network'], 'выгрузка SIM с IP'],
  [G, /^\/api\/excel\/export$/, ['points.export'], 'выгрузка комплексов'],
  [G, /^\/api\/excel\/(template|sim-template|sim-ip-template|sim-ip-registry-template)$/, ['points.import'], 'шаблоны загрузки'],
  [W, /^\/api\/excel\//, ['points.import'], 'загрузка из Excel'],
  [null, /^\/api\/pautina(\/|$)/, ['points.import'], 'загрузка из «Паутины»'],
  [null, /^\/api\/check(\/|$)/, ['check.use'], 'проверка комплексов'],
  [G, /^\/api\/task-visit-reports(\/|$)/, [CORE], 'отчёты о выездах: чтение'],
  [W, /^\/api\/task-visit-reports(\/|$)/, ['reports.edit'], 'отчёты о выездах: изменения'],
  [G, /^\/api\/reports(\/|$)/, ['reports.view', 'calendar.print'], 'отчёты'],
  [W, /^\/api\/reports(\/|$)/, ['reports.edit', 'calendar.print'], 'отчёты: изменения'],
  [G, /^\/api\/(report-designs|report-templates)(\/|$)/, ['reports.view'], 'конструктор отчётов: чтение'],
  [W, /^\/api\/(report-designs|report-templates)(\/|$)/, ['reports.builder'], 'конструктор отчётов: изменения'],
  [null, /^\/api\/visit-history(\/|$)/, ['reports.edit'], 'история выездов'],
  [null, /^\/api\/forms-import(\/|$)/, ['reports.edit'], 'загрузка из Яндекс Форм'],
  [G, /^\/api\/monitoring\/photos/, ['photos.view'], 'фото'],
  [W, /^\/api\/monitoring\/photos\/upload$/, ['photos.upload'], 'добавить фото'],
  [W, /^\/api\/monitoring\/photos/, ['photos.delete'], 'удалить фото'],
  [G, /^\/api\/monitoring(\/|$)/, ['monitoring.view'], 'мониторинг'],
  [W, /^\/api\/monitoring(\/|$)/, ['monitoring.manage'], 'мониторинг: изменения'],
  [G, /^\/api\/stats(\/|$)/, ['stats.view'], 'статистика'],
  [G, /^\/api\/stat-counters(\/|$)/, ['stats.view'], 'счётчики статистики'],
  [W, /^\/api\/stat-counters\/(preview|points)$/, ['stats.view'], 'счётчики: предпросмотр'],
  [W, /^\/api\/stat-counters(\/|$)/, ['stats.counters'], 'счётчики: изменения'],
  [G, /^\/api\/verification-requests(\/|$)/, ['notifications.view', 'calendar.view', 'monitoring.view'], 'проверки комплексов'],
  [G, /^\/api\/(notifications|access-issues|demontage-requests|join-requests)(\/|$)/, ['notifications.view', 'calendar.view'], 'уведомления и заявки'],
  [W, /^\/api\/(notifications|access-issues|verification-requests|demontage-requests|join-requests)(\/|$)/, ['notifications.resolve'], 'решения по заявкам'],
  [null, /^\/api\/chat\/broadcast(\/|$)/, ['chat.broadcast'], 'массовая рассылка'],
  [G, /^\/api\/chat(\/|$)/, ['chat.view'], 'чат'],
  [W, /^\/api\/chat\/\d+\/read$/, ['chat.view'], 'отметить прочитанной'],
  [W, /^\/api\/chat(\/|$)/, ['chat.use'], 'чат: отправка'],
  [G, /^\/api\/account-chat(\/|$)/, ['chat.view'], 'личные сообщения: чтение'],
  [W, /^\/api\/account-chat(\/|$)/, ['chat.use'], 'личные сообщения: отправка'],
  [G, /^\/api\/live-maps(\/|$)/, ['maps.manage', 'points.view'], 'живые карты: чтение'],
  [W, /^\/api\/live-maps(\/|$)/, ['maps.manage'], 'живые карты'],
  [G, /^\/api\/(equipment|warehouse|solar-panels)(\/|$)/, ['warehouse.view'], 'склад: чтение'],
  [W, /^\/api\/equipment\/export\//, ['warehouse.view'], 'выгрузка склада в Excel'],
  [W, /^\/api\/(equipment|warehouse|solar-panels)(\/|$)/, ['warehouse.edit'], 'склад: операции'],
  [null, /^\/api\/assistant(\/|$)/, ['assistant.use'], 'ИИ-помощник'],
];

export function requiredPerms(method: string, reqPath: string): { need: string[]; note: string } {
  const m = method.toUpperCase();
  for (const [methods, rx, perms, note] of RULES) {
    if ((methods === null || methods.has(m)) && rx.test(reqPath)) {
      return { need: perms, note };
    }
  }
  return { need: G.has(m) || m === 'OPTIONS' ? [CORE] : [ALL], note: 'нет правила' };
}

export function isAllowed(method: string, reqPath: string, perms: string[]): { ok: boolean; need: string[]; note: string } {
  const { need, note } = requiredPerms(method, reqPath);
  const ps = new Set(perms || []);
  if (ps.has(ALL) || need.includes(PUBLIC)) return { ok: true, need, note };
  for (const n of need) {
    if (n === CORE) {
      if (hasAnyPerm(ps, CORE_READ)) return { ok: true, need, note };
    } else if (ps.has(n)) {
      return { ok: true, need, note };
    }
  }
  return { ok: false, need, note };
}
