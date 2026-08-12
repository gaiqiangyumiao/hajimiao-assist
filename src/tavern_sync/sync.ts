import { SyncOptions, SyncResult } from './types';

/** 把酒馆 v2 内嵌世界书条目 (character_book) 转成酒馆助手 WorldbookEntry 格式 */
function convertEmbeddedWorldbookEntries(
  character_book: SillyTavern.v2WorldInfoBook,
): TypeFest.PartialDeep<WorldbookEntry>[] {
  const logic_map: ['and_any', 'and_all', 'not_all', 'not_any'] = ['and_any', 'and_all', 'not_all', 'not_any'];

  const position_map: Record<string, WorldbookEntry['position']['type']> = {
    before_character: 'before_character_definition',
    after_character: 'after_character_definition',
    before_example_messages: 'before_example_messages',
    after_example_messages: 'after_example_messages',
    before_author_note: 'before_author_note',
    after_author_note: 'after_author_note',
    at_depth: 'at_depth',
  };

  return Object.entries(character_book.entries)
    .map(([id, entry]): TypeFest.PartialDeep<WorldbookEntry> => {
      const ext = entry.extensions ?? {};
      const position_type = position_map[entry.position ?? 'before_character'] ?? 'before_character_definition';
      return {
        uid: entry.id ?? Number(id),
        name: entry.comment || `条目 ${entry.id ?? id}`,
        enabled: entry.enabled ?? true,
        strategy: {
          type: entry.selective ? 'selective' : 'constant',
          keys: entry.keys ?? [],
          keys_secondary: {
            logic: logic_map[ext.selectiveLogic] ?? 'and_any',
            keys: entry.secondary_keys ?? [],
          },
          scan_depth: ext.scan_depth ?? 'same_as_global',
        },
        position: {
          type: position_type,
          role: 'system',
          depth: position_type === 'at_depth' ? (ext.depth ?? 0) : 0,
          order: entry.insertion_order ?? 0,
        },
        content: entry.content ?? '',
        probability: ext.useProbability ? Math.round((ext.probability ?? 1) * 100) : 100,
        recursion: {
          prevent_incoming: ext.prevent_recursion ?? false,
          prevent_outgoing: ext.exclude_recursion ?? false,
          delay_until: ext.delay_until_recursion ? (ext.depth ?? 0) : null,
        },
        effect: {
          sticky: null,
          cooldown: null,
          delay: null,
        },
        extra: ext,
      };
    })
    .sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
}

/** 同步世界书: 内容对齐 + 绑定主世界书 (不改变目标卡已绑定的附加世界书) */
async function syncWorldbooks(
  source_name: string,
  source: Character,
  target_name: string,
  result: SyncResult,
): Promise<void> {
  const char_worldbooks = getCharWorldbookNames(source_name);

  // 收集要同步的世界书: 主世界书 + 附加世界书 + 内嵌世界书
  const worldbooks: { name: string; entries: TypeFest.PartialDeep<WorldbookEntry>[] }[] = [];

  if (char_worldbooks.primary) {
    worldbooks.push({ name: char_worldbooks.primary, entries: await getWorldbook(char_worldbooks.primary) });
  }
  for (const name of char_worldbooks.additional) {
    worldbooks.push({ name, entries: await getWorldbook(name) });
  }

  // 源卡有内嵌世界书时, 转为独立世界书 (以源卡名为世界书名)
  const char_data = getCharData(source_name);
  const character_book = char_data?.data?.character_book;
  if (character_book && Object.keys(character_book.entries ?? {}).length > 0) {
    worldbooks.push({
      name: source_name,
      entries: convertEmbeddedWorldbookEntries(character_book),
    });
    result.notes.push(`源卡内嵌世界书已转为独立世界书 '${source_name}'`);
  }

  // 逐本创建/更新, 单本失败不中断整体
  for (const wb of worldbooks) {
    try {
      await createOrReplaceWorldbook(wb.name, wb.entries, { render: 'none' });
      result.worldbooks.push(wb.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.notes.push(`世界书 '${wb.name}' 同步失败: ${message}`);
    }
  }

  // 绑定主世界书: 写到目标卡的 data.extensions.world
  const primary = source.extensions?.world ?? char_worldbooks.primary;
  if (primary) {
    await updateCharacterWith(target_name, target => {
      target.extensions.world = primary;
      return target;
    });
  }

  // 附加世界书的绑定无法安全写回, 提示手动切换
  if (char_worldbooks.additional.length > 0) {
    result.notes.push('附加世界书内容已同步, 但绑定需在目标卡世界书面板手动切换');
  }
}

/**
 * 把源卡的数据同步到目标卡 (纯酒馆内部)
 *
 * @throws 校验失败时抛出错误
 */
async function syncCharacter(source_name: string, target_name: string, options: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = {
    source: source_name,
    target: target_name,
    worldbooks: [],
    character_data: false,
    regex_count: 0,
    scripts_variables: false,
    notes: [],
  };

  // ---- 校验 ----
  const names = getCharacterNames();
  if (!names.includes(source_name)) {
    throw new Error(`源卡 '${source_name}' 不存在`);
  }
  if (!names.includes(target_name)) {
    throw new Error(`目标卡 '${target_name}' 不存在`);
  }
  if (source_name === target_name) {
    throw new Error('源卡与目标卡不能相同');
  }

  const source = await getCharacter(source_name);
  // 深拷贝, 避免操作酒馆返回的 proxy 对象
  const source_snapshot = klona(source);

  // ---- 世界书 ----
  if (options.worldbook) {
    await syncWorldbooks(source_name, source_snapshot, target_name, result);
  }

  // ---- 角色卡数据 + 正则 + 脚本/变量 (一次写回) ----
  if (options.character_data || options.regex || options.scripts_variables) {
    await updateCharacterWith(target_name, target => {
      if (options.character_data) {
        target.description = klona(source_snapshot.description);
        target.first_messages = klona(source_snapshot.first_messages);
        target.creator = klona(source_snapshot.creator);
        target.creator_notes = klona(source_snapshot.creator_notes);
      }
      if (options.regex && source_snapshot.extensions?.regex_scripts) {
        target.extensions.regex_scripts = klona(source_snapshot.extensions.regex_scripts);
        result.regex_count = source_snapshot.extensions.regex_scripts.length;
      }
      if (options.scripts_variables && source_snapshot.extensions?.tavern_helper) {
        target.extensions.tavern_helper = klona(source_snapshot.extensions.tavern_helper);
      }
      return target;
    });

    result.character_data = options.character_data;
    result.scripts_variables = options.scripts_variables;
  }

  // 什么都没同步到的时候提示一下
  if (result.worldbooks.length === 0 && !result.character_data && result.regex_count === 0 && !result.scripts_variables) {
    result.notes.push('源卡没有可同步的内容');
  }

  return result;
}

export { syncCharacter };
