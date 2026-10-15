import { describe, expect, test } from "bun:test"

import {
  agentForBinding,
  DEFAULT_AGENT,
  INFOBASE_SKILL_PREFIX,
  isProfileAgent,
  mergeAgentConfig,
  NOPROFILE_AGENT,
  PROFILE_AGENT,
} from "./agents"
import { PACK_SKILL_PREFIX, PACKS } from "./packs"
import { skillFiles } from "./content"
import { MCP_CLIENT_NAME, TOOLKIT_DIR_NAME } from "../mcp/toolkit"

// 2026-09-20, debrief4.md §4, §5, §6. Five behaviours from one session, all of
// them silent -- the loud failure that day blocked the base and stopped
// everything, while these four produced a confident, detailed and wrong
// completion claim that only the user's own memory caught:
//
//  - an interrupted `question` plus a bare «продолжай» 3h25m later was read as
//    consent to the RECOMMENDED option, which was also the most destructive;
//  - the reversible alternative was offered for one catalog element and not
//    the other, so the second was overwritten without ever being asked about;
//  - two questions in one call had mutually contradictory options, the agent
//    noticed and resolved the contradiction silently in its own favour;
//  - «проверю» was promised, dropped across a derailment, and never mentioned
//    again -- including in the summary that declared the task complete;
//  - a correction was read as reversing an explicit earlier choice, without
//    asking.
describe("the profile prompt carries the consent rules", () => {
  const prompt = () => {
    const agent = mergeAgentConfig({}, "C:\\skills").agent as Record<string, { prompt: string }>
    return agent[PROFILE_AGENT]!.prompt
  }

  // failures_to_tools.md T4: the handover's base section comes from the journal.
  test("the handover is built from the write journal, not from memory", () => {
    expect(prompt()).toContain("1c_session_writes")
    expect(prompt().indexOf("1c_session_writes")).toBeGreaterThan(prompt().indexOf("Как откатить"))
  })

  // debrief18.md §18.3 item 4b–e: a loader that swallowed its errors, a dry run
  // that never created anything, a cache that made duplicates, damage not told.
  test("code that writes many objects keeps its errors, rehearses the write, and reports damage first", () => {
    expect(prompt()).toContain("Ошибка записи не глотается")
    expect(prompt()).toContain("`НачатьТранзакцию()` … `ОтменитьТранзакцию()`")
    expect(prompt()).toContain("кладёт созданный элемент в кэш сразу после записи")
    expect(prompt()).toContain("первым же сообщением скажи пользователю")
  })

  test("an interrupted question is not consent", () => {
    expect(prompt()).toContain("Прерванный вопрос — не ответ")
    expect(prompt()).toContain("продолжай")
  })

  test("silence resolves to the reversible option, never the recommended one", () => {
    expect(prompt()).toContain("обратимый вариант, а не рекомендованный")
  })

  test("questions in one call must be independent", () => {
    expect(prompt()).toContain("должны быть независимы")
  })

  test("catalog writes are additive by default, per object", () => {
    expect(prompt()).toContain("добавляй, а не перезаписывай")
    expect(prompt()).toContain("для каждого объекта")
  })

  test("a recorded choice is not reversed without asking", () => {
    expect(prompt()).toContain("Не разворачивай решение пользователя без спроса")
  })

  // 2026-09-21, debrief5.md §9 B4. It asked before the config change — and the
  // question named the procedure («потребуется загрузка конфигурации через
  // конфигуратор») without naming the consequence: a standard БП base that
  // stops updating cleanly, permanently. The approval prompt cannot show that,
  // so the agent has to say it.
  test("costs invisible in the approval prompt must be named", () => {
    expect(prompt()).toContain("Называй цену")
    expect(prompt()).toContain("с поддержки")
    expect(prompt()).toContain("не подтверждение")
  })

  // 2026-09-21, debrief5.md §1a. The red frame in шапка.jpg enclosed two lines.
  // The agent read that correctly twice, then overrode itself with the
  // screenshot's crop boundaries and built three times the task.
  test("an annotation on an image outranks the screenshot's crop", () => {
    expect(prompt()).toContain("Пометка на картинке")
    expect(prompt()).toContain("Границы самого скриншота")
    expect(prompt()).toContain("не расширяй объём молча")
  })

  test("a completion claim reconciles against open promises", () => {
    expect(prompt()).toContain("перечитай, что обещал")
    expect(prompt()).toContain("обязательство")
  })

  // 2026-09-21, debrief6.md §5 / C3. Three identical XDTO rejections produced
  // three guesses at the number; one read of the real file ended it in a single
  // step. This agent recovers correctly the moment it holds ground truth --
  // debrief4.md §2.2 found the same thing -- so the rule only has to fire
  // sooner. Deliberately in the prompt, not in a skill: nothing about it is
  // specific to макеты.
  test("a repeated identical error sends it to the source, not to another guess", () => {
    expect(prompt()).toContain("Одинаковая ошибка на одинаковый вызов дважды")
    expect(prompt()).toContain("идти за фактами")
  })

  // debrief6 §5 / C4. It counted the same thing three ways -- 110, 116, 115 --
  // and reasoned on top of the disagreement without noticing it was there.
  test("measurements that disagree are the finding", () => {
    expect(prompt()).toContain("Расхождение в измерениях")
    expect(prompt()).toContain("сначала объясни")
  })

  // 2026-09-23, debrief7.md §6.6 / D4. Three of 25 replies came back in
  // English, plus two Russian lines calqued from it. The prompt had never named
  // the language -- it was carried implicitly by being written in Russian.
  test("the output language is stated, not implied", () => {
    expect(prompt()).toContain("Пиши пользователю по-русски")
  })

  // debrief7 §6.1 / D5. The макет phase reached for the reference tool after one
  // error; the query phase guessed six times and never did. Nothing structural
  // distinguished the two error texts, so now the prompt does.
  test("each kind of not-found error names the tool that answers it", () => {
    expect(prompt()).toContain("Поле не найдено")
    expect(prompt()).toContain(`${MCP_CLIENT_NAME}_get_metadata`)
    // debrief15.md §15.24 item 34: the dump is read by a tool, not by PowerShell.
    expect(prompt()).toContain(`${MCP_CLIENT_NAME}_dump_object`)
    expect(prompt()).toContain("Поле объекта не обнаружено")
    expect(prompt()).toContain(`${MCP_CLIENT_NAME}_get_bsl_syntax_help`)
    // Consulting the property page does not list enum members; that cost an
    // extra round of guessing on ТипРазмещенияТекстаТабличногоДокумента.
    expect(prompt()).toContain("не перечисляет значения перечисления")
  })

  // debrief7 §6.2 / D8. It spent ten minutes regenerating a 6.8 GB dump that was
  // already on disk, because a tool had reported failure -- and §8.4 shipped a
  // build that was byte-identical to the template it was copied from.
  test("expensive work is checked for before it is redone, and artefacts after", () => {
    expect(prompt()).toContain("проверь, нет ли её уже")
    expect(prompt()).toContain("говорит о связи с")
    expect(prompt()).toContain("Проверяй то, что получилось")
    expect(prompt()).toContain("побайтово равный заготовке")
  })

  // debrief7 §5 / D3. `1c_execute_code` and `1c_dump_config_to_files` went out in
  // one turn; the second closed the base the first needed, and the first died
  // with a bare `fetch failed`.
  test("a configurator operation and a toolkit call may not share a turn", () => {
    expect(prompt()).toContain("не отправляй в одном шаге")
    expect(prompt()).toContain("fetch")
  })

  // 2026-09-21, debrief6.md §7a. The shipped solution to the same task closed
  // with five sections a person could act on -- how to look at it, where to
  // edit the text later, what is still open, how to roll back. Three agent
  // runs produced none of them, and §7 of debrief5 is what that costs: a
  // change nobody but its author can verify or undo.
  test("finishing means handing the work over, not describing the diff", () => {
    expect(prompt()).toContain("передача работы")
    expect(prompt()).toContain("Как проверить глазами")
    expect(prompt()).toContain("Где потом править руками")
    expect(prompt()).toContain("Как откатить")
  })

  // debrief6 §1: it asked about a reversible, disclosable side effect and then
  // sat blocked for 6h50m. Asking was defensible; the cost of asking was not
  // weighed against the cost of the effect.
  test("a disclosable side effect is named, not waited on", () => {
    expect(prompt()).toContain("называй и иди дальше")
    expect(prompt()).toContain("продолжать небезопасно")
  })
})

describe("mergeAgentConfig", () => {
  test("adds both agents, and one profile agent per configuration pack", () => {
    const agent = mergeAgentConfig({}, "C:\\skills").agent as Record<string, unknown>
    expect(Object.keys(agent).sort()).toEqual(
      [NOPROFILE_AGENT, PROFILE_AGENT, ...PACKS.map((pack) => `${PROFILE_AGENT}-${pack.id}`)].sort(),
    )
  })

  // debrief15.md §15.4: reading the profile's dump asked for permission, folder by folder.
  test("the profiles' dumps are readable by every one of our agents without an ask; nothing else is", () => {
    const agent = mergeAgentConfig({}, "C:\\skills", null, ["C:/Bases/zup_conf", "D:\\dumps\\bp\\"]).agent as Record<
      string,
      { permission: Record<string, unknown> }
    >
    for (const name of [PROFILE_AGENT, NOPROFILE_AGENT]) {
      expect(agent[name]!.permission.external_directory).toEqual({
        "*": "ask",
        "C:/Bases/zup_conf/*": "allow",
        "D:\\dumps\\bp/*": "allow",
      })
      // The agent's own rules are kept.
      expect(agent[name]!.permission.skill).toBeDefined()
    }
    const without = mergeAgentConfig({}, "C:\\skills").agent as Record<string, { permission: Record<string, unknown> }>
    expect(without[PROFILE_AGENT]!.permission.external_directory).toBeUndefined()
  })

  test("leaves the rest of the user's config alone", () => {
    const merged = mergeAgentConfig({ model: "their/model", theme: "dark" }, "C:\\skills")
    expect(merged.model).toBe("their/model")
    expect(merged.theme).toBe("dark")
  })

  test("keeps agents the user defined themselves", () => {
    const merged = mergeAgentConfig({ agent: { mine: { prompt: "hello" } } }, "C:\\skills")
    expect((merged.agent as Record<string, unknown>).mine).toEqual({ prompt: "hello" })
  })

  test("keeps skill paths the user added", () => {
    const merged = mergeAgentConfig({ skills: { paths: ["~/my-skills"] } }, "C:\\skills")
    expect((merged.skills as { paths: string[] }).paths).toEqual(["~/my-skills", "C:/skills"])
  })

  // This runs on every launch, and the path differs between a dev run and an
  // installed one. Appending would leave a trail of dead directories.
  test("replaces our own earlier path instead of appending a second one", () => {
    const first = mergeAgentConfig({}, "C:\\old\\1ccoder-skills")
    const second = mergeAgentConfig(first, "C:\\new\\1ccoder-skills")
    expect((second.skills as { paths: string[] }).paths).toEqual(["C:/new/1ccoder-skills"])
  })

  // opencode globs this directory, and node-glob reads a backslash as an
  // escape: a Windows path written here matches nothing, no error, and the
  // whole skill set is silently missing from every session.
  test("writes our skills path with forward slashes", () => {
    const merged = mergeAgentConfig({}, "C:\\Users\\x\\.config\\opencode\\1ccoder-skills")
    expect((merged.skills as { paths: string[] }).paths).toEqual(["C:/Users/x/.config/opencode/1ccoder-skills"])
  })

  // 2026-09-25, skills_rebuild_plan.md Part 2.3: the generic profile agent is
  // the one for an unknown configuration, so it may load no pack at all.
  test("the profile agent can see every skill except configuration packs", () => {
    const agent = (mergeAgentConfig({}, "d").agent as Record<string, any>)[PROFILE_AGENT]
    expect(agent.permission.skill).toEqual({ "*": "allow", [`${PACK_SKILL_PREFIX}*`]: "deny" })
  })

  // Order is the subtle part: Permission.evaluate uses findLast, so the last
  // matching rule wins. Written the other way round, the deny would be
  // overridden by the wildcard and the restriction would quietly do nothing.
  test("the profile-less agent denies infobase skills and packs, after the wildcard", () => {
    const agent = (mergeAgentConfig({}, "d").agent as Record<string, any>)[NOPROFILE_AGENT]
    const keys = Object.keys(agent.permission.skill)
    expect(keys[0]).toBe("*")
    expect(keys.slice(1)).toEqual([`${INFOBASE_SKILL_PREFIX}*`, `${PACK_SKILL_PREFIX}*`])
    expect(agent.permission.skill[`${INFOBASE_SKILL_PREFIX}*`]).toBe("deny")
    expect(agent.permission.skill[`${PACK_SKILL_PREFIX}*`]).toBe("deny")
  })

  // The pack's own allow must come AFTER the blanket pack deny, or findLast
  // picks the deny and the pack agent loads nothing extra.
  for (const pack of PACKS) {
    test(`the ${pack.id} agent may load its own pack and no other, in that order`, () => {
      const agent = (mergeAgentConfig({}, "d").agent as Record<string, any>)[`${PROFILE_AGENT}-${pack.id}`]
      expect(Object.entries(agent.permission.skill)).toEqual([
        ["*", "allow"],
        [`${PACK_SKILL_PREFIX}*`, "deny"],
        [`${PACK_SKILL_PREFIX}${pack.id}-*`, "allow"],
      ])
      expect(agent.permission.infobase_write).toBe("ask")
      expect(agent.prompt).toContain(pack.title)
      expect(agent.hidden).toBe(true)
    })
  }

  test("only the profile agent may write to an infobase", () => {
    const agents = mergeAgentConfig({}, "d").agent as Record<string, any>
    expect(agents[PROFILE_AGENT].permission.infobase_write).toBe("ask")
    expect(agents[NOPROFILE_AGENT].permission.infobase_write).toBe("deny")
  })

  // debrief17.md §17.3: opencode denies `question` to custom agents by default.
  test("every 1CCoder agent may ask the user through `question`", () => {
    const agents = mergeAgentConfig({}, "d").agent as Record<string, any>
    const ours = Object.keys(agents).filter((name) => name.startsWith("1ccoder-"))
    expect(ours.length).toBeGreaterThan(2)
    for (const name of ours) expect(agents[name].permission.question).toBe("allow")
  })

  // 2026-09-24, debrief9.md §9.5 / G6. The prompt names the write route so the
  // first encounter with it is not a refusal, and says the two things that were
  // missing both times a loop rewrote all 8 567 invoices: that the counts have
  // to be obtained BEFORE the write, and that a filter built from the value
  // being written bounds nothing.
  // 2026-09-24. Three sessions found an element by name and rewrote it -- the
  // same two print-settings catalogs each time, with B3 loaded. The prose now
  // names the concrete harm, because "so the user keeps a way back" did not
  // convey that the stored value is the text that prints.
  test("the profile prompt says why rewriting a settings element is not tidying up", () => {
    const prompt = (mergeAgentConfig({}, "d").agent as Record<string, any>)[PROFILE_AGENT].prompt as string
    // Described, not named: the catalogs were БП-only and this prompt reaches
    // every configuration (skills_rebuild_plan.md 1.3).
    expect(prompt).toContain("заголовки, тексты условий")
    expect(prompt).not.toContain("ЗаголовкиСчетовПокупателям")
    expect(prompt).toContain("печатается")
    expect(prompt).toContain("СоздатьЭлемент()")
    expect(prompt).toContain("allow_overwrite: true")
  })

  test("the profile prompt routes base writes through 1c_write_code", () => {
    const prompt = (mergeAgentConfig({}, "d").agent as Record<string, any>)[PROFILE_AGENT].prompt as string
    expect(prompt).toContain("1c_write_code")
    expect(prompt).toContain("КОЛИЧЕСТВО(*)")
    expect(prompt).toContain("до записи")
    expect(prompt).toContain("не равен")
    expect(prompt).toContain("откуда значение берут новые документы")
  })
})

// The rule the draft-to-session carry-over used to skip, leaving profile
// sessions on the default agent: no infobase prompt, no infobase skills, and
// nothing in the UI to say so.
describe("agentForBinding", () => {
  test("a bound profile means the profile agent", () => {
    expect(agentForBinding("p1")).toBe(PROFILE_AGENT)
  })

  test("an explicit no-profile choice means the profile-less agent", () => {
    expect(agentForBinding(null)).toBe(NOPROFILE_AGENT)
  })

  test("an absent binding is treated as no profile, never as one", () => {
    expect(agentForBinding(undefined)).toBe(NOPROFILE_AGENT)
  })

  test("neither is the default agent, which is what 'nobody chose' looks like", () => {
    expect([PROFILE_AGENT, NOPROFILE_AGENT]).not.toContain(DEFAULT_AGENT)
  })

  // 2026-09-25, skills_rebuild_plan.md Part 2.3 / 2.7.
  test("a profile running a configuration with a pack gets that pack's agent", () => {
    expect(agentForBinding("p1", "БухгалтерияПредприятия")).toBe(`${PROFILE_AGENT}-bp30`)
  })

  test("an unknown or undetected configuration gets the generic profile agent", () => {
    expect(agentForBinding("p1", "УправлениеТорговлей")).toBe(PROFILE_AGENT)
    expect(agentForBinding("p1", undefined)).toBe(PROFILE_AGENT)
  })

  test("no profile means no pack, whatever the configuration", () => {
    expect(agentForBinding(null, "БухгалтерияПредприятия")).toBe(NOPROFILE_AGENT)
  })

  // What the renderer's reconcile may replace: our own profile agents, never
  // an agent the user chose.
  test("every agent a binding can select is recognised as ours", () => {
    expect(isProfileAgent(PROFILE_AGENT)).toBe(true)
    for (const pack of PACKS) expect(isProfileAgent(`${PROFILE_AGENT}-${pack.id}`)).toBe(true)
    expect(isProfileAgent(NOPROFILE_AGENT)).toBe(false)
    expect(isProfileAgent("plan")).toBe(false)
  })
})

describe("skill files", () => {
  const files = skillFiles({
    v8pack: '"C:\\skills\\v8pack.cmd"',
    templatesDir: "C:\\skills\\templates",
    templates: ["blank-form.epf", "period-and-file.epf", "print-form.epf"],
    referenceDir: "C:\\skills\\1ccoder-mxl-reference",
    vendored: ["mxl-compile", "mxl-decompile", "mxl-info", "mxl-validate"],
  })

  test("produces the shared skills, the infobase ones and every pack's", () => {
    const infobase = files.filter((file) => file.name.startsWith(INFOBASE_SKILL_PREFIX))
    const packs = files.filter((file) => file.name.startsWith(PACK_SKILL_PREFIX))
    expect(files).toHaveLength(10 + packs.length)
    expect(infobase).toHaveLength(7)
    expect(packs.length).toBeGreaterThan(0)
  })

  // debrief18.md §18.3 items 1 and 4a.
  test("a processing with a form comes from the tool, and files open without the platform's question", () => {
    const designer = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}designer`)!.body
    expect(designer).toContain("передай `form: true`")
    const mcp = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}mcp`)!.body
    expect(mcp).toContain("Защита.ПредупреждатьОбОпасныхДействиях = Ложь;")
    expect(mcp).toContain("ВнешниеОбработки.Подключить(Адрес,")
    const check = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}form-check`)!.body
    expect(check).toContain("ВнешниеОбработки.Подключить(Адрес, , Ложь, Защита);")
    const print = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}print-forms`)!.body
    expect(print).not.toContain("ВнешниеОбработки.Создать(путь")
  })

  // debrief16.md §16.3: each assertion stands for one failure of a report run.
  test("the reports skill carries the points a report run got wrong", () => {
    const body = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}reports`)!.body
    expect(body).toContain("Источник строк — решение, а не деталь")
    expect(body).toContain("не суммируй")
    expect(body).toContain("на номенклатуру с пустой характеристикой")
    expect(body).toContain("1c_new_external")
    expect(body).toContain("1c_run_report")
    expect(body).toContain("Прочитай PDF")
    expect(body).toContain("МинимальнаяШирина")
    expect(body).toContain("denyIncompleteValues")
    // debrief17.md §17.3
    expect(body).toContain("у всех строк отчёта должна быть одна валюта")
    expect(body).toContain("зависит от этого признака, а не от имени поля")
    expect(body).toContain("Ссылочное значение по умолчанию")
    expect(body).toContain("отдельный вариант")
  })

  // A pack skill outside its pack's prefix would escape the permission rule
  // and reach every session -- exactly what the packs exist to prevent.
  test("every pack skill carries its pack's prefix", () => {
    for (const pack of PACKS) {
      for (const skill of pack.skills({ v8pack: "v8pack", templatesDir: "t", templates: [], referenceDir: "r", vendored: [] })) {
        expect(skill.name.startsWith(`${PACK_SKILL_PREFIX}${pack.id}-`)).toBe(true)
        expect(skill.body).toContain(`name: ${skill.name}`)
      }
    }
  })

  // 2026-09-21, debrief5.md §9 A2. Three sessions made the same class of
  // mistake on печатные формы and there was no skill covering any of it:
  // debrief3.md §11 recommended this file and it was never written. Each
  // assertion below stands for one observed failure, so a rewrite that drops
  // the point fails here rather than in a client's base.
  describe("the print-forms skill carries what three sessions got wrong", () => {
    const pf = () => files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}print-forms`)!

    // debrief5 §1a/§2.4: one requirement needed a макет, so the whole task
    // moved into an external form -- including the two parts that were data.
    test("it says to pick a mechanism per requirement, not per task", () => {
      expect(pf().body).toContain("для каждого требования отдельно")
      expect(pf().body).toContain("откуда форма берёт это поле")
      expect(pf().body).toContain("новое значение настройки")
    })

    // debrief5 §1a: the red frame marked two lines; the crop of the screenshot
    // was treated as the specification instead.
    test("it says the annotation is the specification, not the screenshot's edges", () => {
      expect(pf().body).toContain("пометка и есть")
      expect(pf().body).toContain("Границы самого скриншота")
    })

    // debrief3 §11: the ladder, and the cost of the bottom rung stated in the
    // words a user would need to hear before approving it.
    test("it ranks the mechanisms and names what rung 5 costs", () => {
      expect(pf().body).toContain("ПользовательскиеМакетыПечати")
      expect(pf().body).toContain("снимает базу с поддержки")
    })

    // debrief5 §3: 51 ЗаполнитьЯчейку calls, 0 ПолучитьОбласть.
    test("it forbids building layout in code and points at the template", () => {
      expect(pf().body).toContain("ПолучитьОбласть")
      expect(pf().body).toContain("Не заполняй ячейки кодом")
      expect(pf().body).toContain("print-form.epf")
    })

    // debrief5 §5: one success:true hid three inert fields.
    test("it names the three registration traps", () => {
      expect(pf().body).toContain("ХранилищеЗначения")
      expect(pf().body).toContain("ИдентификаторОбъектаМетаданных")
      expect(pf().body).toContain("ОтключитьКомандыПечати")
    })

    // debrief5 §6: the only reason those three were caught.
    test("it says to verify through the path the user takes", () => {
      expect(pf().body).toContain("КомандыПечатиФормы")
      expect(pf().body).toContain("посмотри его")
    })

    // 2026-09-23, debrief7.md §6.7 / D6. Two consecutive sessions dumped the
    // whole макет (≈100 rows × 30 columns), overflowed the tool output and
    // learned nothing the area bounds would not have given them.
    test("it says to read the макет by area and by the rows being changed", () => {
      expect(pf().body).toContain("Читай макет прицельно")
      expect(pf().body).toContain("Макет.Области")
    })

    // debrief7 §6.5 / D7. §4 used to hand over `ПолучитьОбщийМакет("ПФ_MXL_СчетЗаказ")`
    // as a worked example; the agent had read it eight minutes earlier and still
    // guessed the document owned that template. The base can answer this.
    test("it says to ask the base which object owns the макет", () => {
      expect(pf().body).toContain("Метаданные.ОбщиеМакеты")
      expect(pf().body).toContain("Не угадывай")
    })

    // 2026-09-21, debrief6.md §5/§7a. The run that got every earlier point
    // right then spent 3h02m on one subtitle row: it minted a format record to
    // carry an explicit height, where the shipped solution simply turned on
    // автоподбор. The property exists; the arithmetic never needed doing.
    test("it says to reach for the property before computing a size", () => {
      expect(pf().body).toContain("АвтоВысотаСтроки")
      expect(pf().body).toContain("РазмещениеТекста")
    })

    // debrief6 §5: it picked the row flagged empty because it looked free.
    // That flag is exactly what makes the row unusable -- it is suppressed
    // even with a height set, which cost roughly an hour to establish.
    // 2026-09-23, debrief8.md §E10. The rule used to say a formerly-empty row
    // "не выводится вообще — ни с текстом, ни с заданной высотой". Diffing the
    // макет exported before and after the edit disproved it: `<empty>` is
    // cleared by the platform as soon as the row gets content, and the row does
    // not print because it has no `formatIndex`, hence no height. The advice
    // survived; the reason for it did not, and a rule justified by the wrong
    // mechanism misleads as soon as the situation shifts.
    test("it explains the empty row by height, not by the flag", () => {
      expect(pf().body).toContain("нет высоты")
      expect(pf().body).toContain("следствие")
      expect(pf().body).toContain("нет `formatIndex`")
    })

    // 2026-09-23, debrief9.md §9.10 S2. Third explanation of the same row, and
    // the first one verified against the макет's merge table: 1-based row 24 of
    // ПФ_MXL_СчетЗаказ is the bottom half of the title cell's vertical merge
    // (`<merge><r>22</r><c>1</c><h>1</h>`). Writing into it and merging across
    // destroyed the title's own merge, and the heading printed one character per
    // line. Height was never the reason THIS row resisted.
    test("it tells the agent to read the merges before touching a row", () => {
      expect(pf().body).toContain("прочитай объединения")
      expect(pf().body).toContain("нижней половиной ячейки")
      expect(pf().body).toContain("<merge>")
      expect(pf().body).toContain("вертикально, по одному символу в строке")
    })

    // G7: the fact lives in a tool, not a prose pointer to a skill script. Two
    // runs of two declined the script; this agent calls tools. The skill must
    // also say why the runtime cannot answer, or the tool looks redundant.
    test("it routes the merge question to 1c_mxl_info, not to the runtime", () => {
      expect(pf().body).toContain("1c_mxl_info")
      expect(pf().body).toContain("объектная модель объединения не показывает")
      expect(pf().body).not.toContain("`/mxl-info`")
    })

    // The rule used to say the opposite, and the opposite was wrong: insertion
    // preserved every merge and auto-expanded the named area, while reuse of the
    // existing row was what broke things.
    test("it says ВставитьОбласть does not break merges, with the right enum value", () => {
      expect(pf().body).toContain("`ВставитьОбласть` объединения **не ломает**")
      expect(pf().body).toContain("ТипСмещенияТабличногоДокумента.ПоВертикали")
      expect(pf().body).toContain("не `Вниз`")
      expect(pf().body).not.toContain("ломает объединения в соседних строках")
    })

    // §9.10 S3: АвтоВысотаСтроки was insufficient on a second base too, so the
    // explicit-height advice is no longer a one-base hypothesis.
    test("it says auto height is not always enough, and what to do then", () => {
      expect(pf().body).toContain("`АвтоВысотаСтроки` помогает не всегда")
      expect(pf().body).toContain("ставь `ВысотаСтроки`")
      expect(pf().body).toContain("гипотеза для другой")
    })

    // The same diff showed АвтоВысотаСтроки failing on this base where it had
    // worked on another (debrief7 §6.13), so the skill must not present one
    // base's fix as the answer for another.
    test("it warns that a fix verified on one base is a hypothesis on another", () => {
      expect(pf().body).toContain("гипотеза для другой")
    })

    // debrief6 §7a: the shipped solution never opened Template.xml. Editing
    // the XML is the symptom of a property not found, so the skill has to say
    // so where the agent is standing when it starts -- not in a footnote.
    test("it treats XML surgery as a signal, not a technique", () => {
      expect(pf().body).toContain("признак того, что свойство не найдено")
      expect(pf().body).toContain("остановись")
    })

    // debrief6 §5: `success: true` carried `высота=0` in the same string, and
    // the render that would have shown it came six minutes before the kill.
    test("it says to render early and to read the payload, not the envelope", () => {
      expect(pf().body).toContain("Первый PDF")
      expect(pf().body).toContain("код выполнился, а не что он сработал")
    })
  })

  test("names are unique, since one file per name is written to disk", () => {
    const names = files.map((file) => file.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // The whole permission rule depends on this prefix. A skill misnamed here is
  // visible to a session that has no infobase to run it against.
  test("every infobase skill carries the prefix the deny rule matches", () => {
    const names = files.map((file) => file.name)
    expect(names).toContain(`${INFOBASE_SKILL_PREFIX}designer`)
    expect(names).toContain(`${INFOBASE_SKILL_PREFIX}enterprise`)
    expect(names).toContain(`${INFOBASE_SKILL_PREFIX}mcp`)
    expect(names).toContain(`${INFOBASE_SKILL_PREFIX}toolkit-launch`)
    expect(names).toContain(`${INFOBASE_SKILL_PREFIX}form-check`)
  })

  // The build says nothing about a form module, which is exactly the trap this
  // skill exists to close. If the wording goes, so does the warning.
  test("the form-check skill says the batch build is not a check", () => {
    const check = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}form-check`)!
    expect(check.body).toContain("Модули при этом не")
    expect(check.body).toContain("ВнешниеОбработки.Подключить")
    expect(check.body).toContain("Возникла непредвиденная ситуация")
  })

  // 2026-09-25, observed live. A built .epf carried a correct
  // `ПриСозданииНаСервере` that `Form.xml` never bound, so it was dead code: the
  // form opened and did nothing. Compilation cannot catch it -- the code is
  // valid -- and the agent had bound its two commands correctly with `<Action>`,
  // so the gap is the difference between the two idioms, not carelessness.
  test("the form-check skill explains that handlers do not bind by name", () => {
    const body = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}form-check`)!.body
    expect(body).toContain("по имени процедуры не привязывается ничто")
    expect(body).toContain('<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>')
    // Commands are a different mechanism, and getting them right proves nothing
    // about events.
    expect(body).toContain("Form.Command.")
    expect(body).toContain("не привязать ни одного события")
    // Directive per event, harvested from 401 form+module pairs.
    expect(body).toContain("`OnCreateAtServer` | `&НаСервере`")
    expect(body).toContain("`OnOpen` | `&НаКлиенте`")
  })

  // failures_to_tools.md T1. The agent reproduces worked examples and skips
  // pointers to tools, so the example IS the tool call, ahead of the recipe.
  test("the form-check skill's first example is the check tool, before the manual recipe", () => {
    const body = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}form-check`)!.body
    expect(body).toContain(`${MCP_CLIENT_NAME}_check_epf(`)
    expect(body.indexOf(`${MCP_CLIENT_NAME}_check_epf(`)).toBeLessThan(body.indexOf("ВнешниеОбработки.Подключить"))
  })

  // 2026-09-16, §3.2 of the debrief: three execute_code runs failed, the agent
  // unpacked MCP_Toolkit.epf, and concluded that ВнешниеОбработки.Создать()
  // defaults to safe mode. Nine minutes and six tool calls, written down here
  // so nobody would repeat them.
  //
  // 2026-09-20, debrief4.md §2.3: THAT CONCLUSION WAS WRONG, and these tests
  // held it in place for four days. The toolkit contains no
  // ВнешниеОбработки.Создать, no БезопасныйРежим and no УстановитьБезопасныйРежим
  // anywhere; execute_code is a bare Выполнить(Код) in a
  // &НаСервереБезКонтекста function. File operations demonstrably work -- a
  // session read two files and wrote a PDF and an XML dump through
  // execute_code while the skill was telling it that was impossible. The real
  // constraint is the toolkit's own call-site keyword filter.
  //
  // The lesson is in the test that used to sit here, "it says not to unpack
  // the .epf to work this out": the skill forbade the one check that would
  // have exposed the error, and a test asserted the prohibition. A wrong fact
  // is a bug; a wrong fact plus an instruction not to verify it is a trap.
  // Nothing below may assert that some part of the system must not be looked
  // at.
  describe("the toolkit skill states the real execution contract", () => {
    const mcp = () => files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}mcp`)!

    test("it denies the safe-mode story rather than leaving it to be re-learned", () => {
      expect(mcp().body).toContain("Безопасного режима 1С здесь **нет**")
      expect(mcp().body).toContain("Выполнить(Код)")
    })

    test("it names the real gate: the toolkit's own keyword filter", () => {
      expect(mcp().body).toContain("фильтр самого тулкита")
      expect(mcp().body).toContain("Операция запрещена")
    })

    test("it says file reading is not restricted, so no workaround gets invented", () => {
      expect(mcp().body).toContain("Чтение файлов не ограничено")
      expect(mcp().body).toContain("ЧтениеТекста")
    })

    test("it warns that the auto-allow flags cover only two of the keywords", () => {
      expect(mcp().body).toContain("КопироватьФайл")
      expect(mcp().body).toContain("УстановитьПривилегированныйРежим")
    })

    // 2026-09-20. MCP_Toolkit.epf is patched locally and stays patched: both
    // auto-allow flags default to Истина. `danger_confirm` is not defaulted and
    // the app sends no danger_* params, so every keyword WITHOUT an auto-allow
    // flag is refused outright -- there is no confirmation dialog to fall back
    // on. The skill has to describe that deployment, not the shipped default.
    test("it describes the patched deployment: writes pass, the rest is refused", () => {
      expect(mcp().body).toContain("По умолчанию включены оба автоматических")
      expect(mcp().body).toContain("отклоняется сразу")
      expect(mcp().body).not.toContain("бывают сняты")
    })

    // The trap that will actually be hit: the filter matches calls after a dot
    // too, so Массив.Удалить(0) -- ordinary BSL, nothing dangerous about it --
    // is refused, and no flag can permit it.
    test("it warns that Удалить fires on in-memory collections", () => {
      expect(mcp().body).toContain("Массив.Удалить(0)")
      expect(mcp().body).toContain("собери новый массив")
    })

    test("it gives the dot rule for the eval primitives", () => {
      expect(mcp().body).toContain("Запрос.Выполнить()")
      expect(mcp().body).toContain("не после точки")
    })

    // §4.1: the reversible option was offered for the header element and not
    // for the conditions element, so the second was overwritten silently. The
    // rule has to be per object, or it just moves which object gets lost.
    test("the execute_code contract makes catalog writes additive by default", () => {
      expect(mcp().body).toContain("добавляй, а не перезаписывай")
      expect(mcp().body).toContain("для каждого объекта")
      expect(mcp().body).toContain("не основание")
    })

    test("it routes a refusal to the user instead of to a workaround", () => {
      expect(mcp().body).toContain("Обходить фильтр нельзя")
      expect(mcp().body).toContain("остановись и скажи")
    })

    // The trap this section used to set. Guard against its return in any form.
    test("it never tells the agent not to inspect part of the system", () => {
      expect(mcp().body).not.toContain("Не разбирай")
      expect(mcp().body).not.toMatch(/УстановитьБезопасныйРежим\(Ложь\)/)
      expect(mcp().body).not.toContain("ВнешниеОбработки.Создать()")
    })

    // A wall with no door is worse than no warning: the agent needs the route
    // out, not just the reason it is stuck.
    test("it routes real file writing to the separate /Execute launch", () => {
      expect(mcp().body).toContain("1c_run_epf")
      expect(mcp().body).toContain(`${INFOBASE_SKILL_PREFIX}enterprise`)
    })

    // 2026-09-20, debrief4.md §2.2. The .epf launcher used to be called
    // "1c_execute" -- a strict prefix of the toolkit's "1c_execute_code" and
    // "1c_execute_query". Across three sessions the agent emitted it, with a
    // path argument, when its reasoning said it meant one of the other two.
    // Note this assertion cannot be written as toContain("1c_execute"): that
    // substring still appears inside "1c_execute_code", which is exactly the
    // collision being removed, and is why the previous version of the test
    // above would have passed unchanged through the rename.
    test("the .epf launcher is not named as a prefix of the toolkit's code tools", () => {
      expect(mcp().body).not.toMatch(/`1c_execute`/)
      expect(mcp().body).not.toMatch(/\b1c_execute\b(?!_)/)
    })

    test("it offers the cheaper route first, which needs no file at all", () => {
      expect(mcp().body).toContain("Результат")
      expect(mcp().body).toContain("ЗаписьJSON")
    })
  })

  // 2026-09-16, §3.5 of the debrief: five tool calls lost to the machine
  // rather than the task -- reaching for rg, which is not installed; a Python
  // child process dying on cp1252 while printing Cyrillic; python -c quoting
  // collapsing into SyntaxError; and Get-Item without -LiteralPath mangling a
  // Cyrillic .epf name. Each is one sentence, and none of them was written
  // down. These assertions keep them written.
  describe("the shell skill front-loads the facts about this machine", () => {
    const shell = () => files.find((file) => file.name === "1ccoder-shell")!

    // debrief14.md §14.4: twelve minutes of XML scripting in PowerShell 5.1.
    test("it names the encoding and unrolling traps, and sends XML lookups to grep and read", () => {
      expect(shell().body).toContain("`.ps1` без BOM")
      expect(shell().body).toContain("`return ,$obj`")
      expect(shell().body).toContain("это `grep` и `read`")
    })

    // debrief15.md §15.14 item 2: a failed step didn't stop the script, it saved,
    // and a full rerun applied the earlier steps twice.
    test("a script that writes a file stops at the first error, and a retry doesn't re-apply what passed", () => {
      expect(shell().body).toContain("$ErrorActionPreference = 'Stop'")
      expect(shell().body).toContain("не запускай его целиком снова")
      expect(shell().body).toContain("`local-name()='item'`")
    })

    test("it says rg is not installed", () => {
      // The skill already steers to the grep tool; that does not help an agent
      // that puts rg in a shell command anyway.
      expect(shell().body).toContain("`rg` на этой машине нет")
    })

    test("it covers the child process encoding, not just PowerShell's own", () => {
      // Two different mechanisms with one symptom. The OutputEncoding line
      // does nothing for a Python subprocess.
      expect(shell().body).toContain("[Console]::OutputEncoding")
      expect(shell().body).toContain("PYTHONIOENCODING")
      expect(shell().body).toContain("UnicodeEncodeError")
    })

    test("it reads ????? as an encoding symptom rather than damaged data", () => {
      // The expensive misreading: treating mangled output as a broken export
      // and going to fix the data.
      expect(shell().body).toContain("?????")
      expect(shell().body).toContain("Проверь кодировку прежде")
    })

    test("it requires -LiteralPath for Cyrillic and special-character paths", () => {
      expect(shell().body).toContain("-LiteralPath")
    })

    test("it tells the agent to stop escalating python -c quoting", () => {
      // Escalating the escaping is the trap: it re-breaks on the next quote.
      expect(shell().body).toContain("unterminated string literal")
      expect(shell().body).toContain("запиши скрипт в файл")
    })
  })

  // The old wording told the agent the app always starts the toolkit and knows
  // a password the agent does not have. Both can be false, and an agent that
  // believes them has no way out of a toolkit that failed to start.
  test("the toolkit skill points at a recovery path instead of forbidding one", () => {
    const mcp = files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}mcp`)!
    expect(mcp.body).not.toContain("приложение делает это само и знает пароль")
    expect(mcp.body).toContain(`${INFOBASE_SKILL_PREFIX}toolkit-launch`)
  })

  test("each file opens with frontmatter naming itself", () => {
    for (const file of files) {
      expect(file.body.startsWith("---\n")).toBe(true)
      expect(file.body).toContain(`name: ${file.name}`)
    }
  })

  test("the description is a single line, which the YAML loader requires", () => {
    for (const file of files) {
      const description = file.body.split("\n").find((line) => line.startsWith("description: "))
      expect(description).toBeDefined()
      expect(description!.includes("\n")).toBe(false)
    }
  })

  test("the editing skill bakes in the real v8pack command", () => {
    const editing = files.find((file) => file.name === "1ccoder-epf-editing")!
    expect(editing.body).toContain('"C:\\skills\\v8pack.cmd" unpack')
    expect(editing.body).toContain('"C:\\skills\\v8pack.cmd" pack')
  })

  test("the profile-less skill does not tell the agent to run 1C", () => {
    const editing = files.find((file) => file.name === "1ccoder-epf-editing")!
    expect(editing.body).toContain("без установленной 1С")
  })

  // Observed: the agent called `python .../v8pack.py` five times against a path
  // that did not exist, and wrote its own Python parser for a form container,
  // while the bundled launcher sat unused. Nothing on a target machine provides
  // Python, so every one of those calls is a dead end.
  describe("the editing skill rules out reaching for another tool", () => {
    const editing = () => files.find((file) => file.name === "1ccoder-epf-editing")!

    test("says no runtime is installed on the user's machine", () => {
      expect(editing().body).toContain("ни Python, ни Node, ни 1С")
    })

    test("names v8pack.py as gone, since old task text still asks for it", () => {
      expect(editing().body).toContain("Не ищи `v8pack.py`")
    })

    test("forbids writing a parser of its own", () => {
      expect(editing().body).toContain("Не пиши свой разборщик контейнера")
    })

    // Most processings keep every line of their logic in the form module, and
    // an agent told only about `modules/*.bsl` read "0 object modules" as a
    // broken tool and went looking for the code by hand.
    test("names the form module as a first-class thing to edit", () => {
      expect(editing().body).toContain(".form.bsl")
      expect(editing().body).toContain("модуль формы")
      expect(editing().body).toContain("form module(s)")
    })

    test("tells it to report a broken launcher instead of guessing a path", () => {
      expect(editing().body).toContain("Не подбирай путь наугад")
    })
  })

  // The whole point of shipping templates: an agent that builds a container by
  // hand burns rounds and fails. It needs the directory and the file names.
  describe("the templates skill", () => {
    const templates = () => files.find((file) => file.name === "1ccoder-epf-templates")!

    test("names the directory and every installed template", () => {
      expect(templates().body).toContain("C:\\skills\\templates")
      expect(templates().body).toContain("blank-form.epf")
      expect(templates().body).toContain("period-and-file.epf")
    })

    // v8pack rewrites module texts only. An agent that believes it can add an
    // attribute this way produces a processing whose form does not match its
    // code, and only finds out when the form is opened.
    test("says that attributes and form items are out of v8pack's reach", () => {
      expect(templates().body).toContain("только с текстами модулей")
      expect(templates().body).toContain("Конфигуратором")
    })

    test("lists a template that has no description without dropping it", () => {
      const unknown = skillFiles({
        v8pack: "v8pack",
        templatesDir: "d",
        templates: ["something-new.epf"],
        referenceDir: "r",
        vendored: [],
      }).find((file) => file.name === "1ccoder-epf-templates")!
      expect(unknown.body).toContain("something-new.epf")
    })

    test("survives an empty templates directory", () => {
      const none = skillFiles({ v8pack: "v8pack", templatesDir: "d", templates: [], referenceDir: "r", vendored: [] }).find(
        (file) => file.name === "1ccoder-epf-templates",
      )!
      expect(none.body).toContain("шаблоны не установлены")
    })
  })

  // The port being busy is not a dead end: the occupant can be identified, and
  // the old skill text had no third state between "answering" and "silent".
  // debrief14.md §14.5: three "done" reports whose tests passed on data while
  // what the user saw was broken.
  // debrief15.md §15.11–15.12: a variant of a standard form was redrawn from scratch
  // and checked against nothing but the agent's own expectations.
  describe("the print-forms skill starts from the standard template and compares with the sample", () => {
    const printForms = () => files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}print-forms`)!.body

    test("a variant of a standard form: copy its Template.xml and change the cells", () => {
      expect(printForms()).toContain("начинай с типового макета")
      expect(printForms()).toContain(`${MCP_CLIENT_NAME}_mxl_edit`)
      expect(printForms()).toContain("ПолучитьОбщийМакет")
      expect(printForms()).toContain("Рисовать макет с нуля (`mxl-compile`) — только когда похожей формы в базе нет")
    })

    test("with a sample, the output is compared field by field, including blanks left for handwriting", () => {
      expect(printForms()).toContain("Есть образец — сравни с ним по полям")
      // debrief15.md §15.24 item 31: the comparison is handed in to a tool.
      expect(printForms()).toContain(`Сверку передай в \`${MCP_CLIENT_NAME}_compare_with_sample\``)
      expect(printForms()).toContain("Регистрация обработки без сверки текущей сборки не выполнится")
      expect(printForms()).toContain("пустым для записи от руки")
    })

    // debrief15.md §15.25 item 2: two captioned fields of the sample kept as the standard's one line.
    test("a field is what the sample captions: two captions are two fields, split even without data", () => {
      expect(printForms()).toContain("**Поле — это то, что подписано в образце.**")
      expect(printForms()).toContain("Два поля образца на месте одного типового — отличие")
      expect(printForms()).toContain("оставь его пустым и назови в отчёте, откуда его взять")
    })

    // debrief15.md §15.14, §15.18: a split caption and a wider title went to hand-written XML.
    test("a split cell goes through the tool, and template XML is not edited by hand", () => {
      expect(printForms()).toContain("`unmerge`, два `merge`, вторая")
      expect(printForms()).toContain("XML макета руками не правь")
      expect(printForms()).toContain("шрифтов и линий — с нуля")
    })

    // debrief15.md §15.18: a filled-in acknowledgement date passed as «типовое поведение».
    test("the sample decides, not the standard form: a handwriting blank stays blank", () => {
      expect(printForms()).toContain("а не с тем, как делает типовая форма")
      expect(printForms()).toContain("Рукопись в образце — то, что написано ручкой")
      expect(printForms()).toContain("Печать оставляет такую строку")
      expect(printForms()).toContain("пусто и в печати, даже если типовая заполняет его сама")
    })

    // debrief15.md §15.24: «поверх подчёркиваний» turned printed values into «handwriting».
    test("a value in the form's own typeface is printed, even on a line", () => {
      expect(printForms()).toContain("набранное тем же шрифтом, что и остальной бланк, — печатное")
      expect(printForms()).not.toContain("поверх")
    })

    // debrief15.md §15.14 item 8: registered in the client's base before any print.
    test("print and compare before registering, and re-register after each build", () => {
      expect(printForms()).toContain("Сначала печать и сверка, потом регистрация")
      expect(printForms()).toContain("перерегистрируй после")
    })
  })

  describe("the enterprise skill checks what the user sees", () => {
    const enterprise = () => files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}enterprise`)!.body

    test("a command is called through its navigation link, not by opening its form", () => {
      expect(enterprise()).toContain('ПерейтиПоНавигационнойСсылке("e1cib/command/ОбщаяКоманда.<Имя>")')
      expect(enterprise()).toContain(`${MCP_CLIENT_NAME}_get_screenshot`)
    })

    test("a form is checked by its elements, a report by what its screenshot shows", () => {
      expect(enterprise()).toContain('Форма.Элементы.Найти("<Имя>")')
      expect(enterprise()).toContain("`###` вместо чисел")
      expect(enterprise()).toContain("колонка, пустая во всех строках")
    })

    test("test-only code is removed before the final dump, or reported", () => {
      expect(enterprise()).toContain("Перед итоговой выгрузкой")
    })
  })

  describe("the toolkit-launch skill", () => {
    const launch = () => files.find((file) => file.name === `${INFOBASE_SKILL_PREFIX}toolkit-launch`)!

    test("tells the agent how to identify whoever holds the port", () => {
      expect(launch().body).toContain("СтрокаСоединенияИнформационнойБазы()")
    })

    // The toolkit is no longer started when a profile is bound, so a missing
    // toolkit is the normal state rather than a fault. Observation from a real
    // run: told only to launch the platform itself, the agent assembled a
    // 1cv8.exe command line and got it wrong. Point it at the tool first.
    test("leads with the tool that opens the toolkit, not a hand-built command line", () => {
      const body = launch().body
      expect(body).toContain(`${MCP_CLIENT_NAME}_toolkit_start`)
      expect(body.indexOf(`${MCP_CLIENT_NAME}_toolkit_start`)).toBeLessThan(body.indexOf("1cv8.exe ENTERPRISE"))
    })

    test("warns that returning is not the same as the tools being ready", () => {
      expect(launch().body).toContain("десятки секунд")
    })

    test("says the startup parameter is what starts the server, not opening the file", () => {
      expect(launch().body).toContain("startup;mode=embedded;port=")
      expect(launch().body).toContain("это и есть запуск сервиса")
    })

    // The parameter only works on a build recent enough to parse it. Old copies
    // sit beside infobases and start only from the form's button, which looks
    // exactly like a broken launch unless the skill names the cause.
    test("names a stale build as the reason a launched toolkit stays silent", () => {
      expect(launch().body).toContain("сборка старая")
      expect(launch().body).toContain("«Подключиться»")
      expect(launch().body).toContain(TOOLKIT_DIR_NAME)
    })
  })
})

describe("plugin registration", () => {
  // Forward slashes on purpose: a Windows path written in a TypeScript string
  // turns "\1" into a control character, which is how an earlier version of
  // this test quietly compared the wrong value.
  const plugin = { path: "C:/skills/1ccoder-plugin.mjs", baseUrl: "http://127.0.0.1:1234" }

  test("registers the plugin with the relay address, which is how it learns the port", () => {
    const merged = mergeAgentConfig({}, "C:/skills", plugin)
    expect(merged.plugin).toEqual([[plugin.path, { baseUrl: plugin.baseUrl }]])
  })

  test("keeps plugins the user configured themselves", () => {
    const merged = mergeAgentConfig({ plugin: ["their-plugin"] }, "C:/skills", plugin)
    expect((merged.plugin as unknown[])[0]).toBe("their-plugin")
  })

  // Both the path and the port change between launches, so appending would
  // leave the sidecar loading a plugin pointed at a dead port.
  test("replaces our own earlier registration rather than appending", () => {
    const stale = { path: "C:/old/1ccoder-plugin.mjs", baseUrl: "http://127.0.0.1:1" }
    const first = mergeAgentConfig({}, "d", stale)
    const second = mergeAgentConfig(first, "d", plugin)
    expect(second.plugin).toEqual([[plugin.path, { baseUrl: plugin.baseUrl }]])
  })

  test("registers nothing when there is no plugin to register", () => {
    expect(mergeAgentConfig({}, "C:/skills").plugin).toBeUndefined()
  })
})
