import { describe, expect, test } from "bun:test"

import {
  bindFormEvents,
  describeBindings,
  describeFormBindings,
  inspectFormBindings,
  KNOWN_EVENTS,
  parseFormBindings,
  parseModuleProcedures,
} from "./form-bindings"

// 2026-09-25, observed live. `НастройкаШаблоновСчета.epf` shipped with a correct
// `ПриСозданииНаСервере` in the form module and no `<Events>` block in Form.xml,
// so the handler was dead code: the form opened and did nothing. Neither the
// build nor `1c_check_epf` can see this -- the procedure compiles, and creating
// the form succeeds precisely because nothing is wired.
//
// Note what the agent got RIGHT, because the guard must not punish it: both form
// commands were bound properly with `<Action>`, and the buttons pointed at the
// commands. It knew one binding idiom and assumed events bound by name, which is
// true in the Designer and false in the XML.
const FORM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.21">
\t<AutoCommandBar name="ФормаКоманднаяПанель" id="-1">
\t\t<ChildItems>
\t\t\t<Button name="ФормаПрименить" id="11">
\t\t\t\t<Type>CommandBarButton</Type>
\t\t\t\t<CommandName>Form.Command.Применить</CommandName>
\t\t\t</Button>
\t\t</ChildItems>
\t</AutoCommandBar>
\t<Commands>
\t\t<Command name="Применить" id="1">
\t\t\t<Action>КомандаПрименить</Action>
\t\t</Command>
\t</Commands>
</Form>`

const MODULE = `&НаСервере
Процедура ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)
\tЗаполнитьНастройки();
КонецПроцедуры

&НаКлиенте
Процедура КомандаПрименить(Команда)
\tПрименитьНастройкиНаСервере();
КонецПроцедуры

&НаСервереБезКонтекста
Функция ПрименитьНастройкиШаблонов(Настройки)
\tВозврат Истина;
КонецФункции`

describe("the handler that shipped unbound", () => {
  test("is reported, with the XML that would bind it", () => {
    const findings = inspectFormBindings({ xml: FORM_XML, module: MODULE })
    expect(findings.length).toBe(1)
    expect(findings[0]!.kind).toBe("unbound")
    expect(findings[0]!.procedure).toBe("ПриСозданииНаСервере")
    expect(findings[0]!.detail).toContain('<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>')
    expect(findings[0]!.detail).toContain("строка 2")
  })

  test("a command bound through <Action> is not reported", () => {
    const findings = inspectFormBindings({ xml: FORM_XML, module: MODULE })
    expect(findings.some((finding) => finding.procedure === "КомандаПрименить")).toBe(false)
  })

  // Ordinary helpers must stay silent or the report becomes noise to skip past.
  test("a helper that is not handler-named is not reported", () => {
    const findings = inspectFormBindings({ xml: FORM_XML, module: MODULE })
    expect(findings.some((finding) => finding.procedure === "ПрименитьНастройкиШаблонов")).toBe(false)
  })

  test("adding the Events block clears it", () => {
    const fixed = FORM_XML.replace(
      "\t<Commands>",
      '\t<Events>\n\t\t<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>\n\t</Events>\n\t<Commands>',
    )
    expect(inspectFormBindings({ xml: fixed, module: MODULE })).toEqual([])
  })
})

// The other two directions fail loudly rather than silently, but they are the
// same question asked of the same pair of files.
describe("bindings that point nowhere", () => {
  test("an event naming a procedure the module lacks", () => {
    const xml = FORM_XML.replace(
      "\t<Commands>",
      '\t<Events>\n\t\t<Event name="OnOpen">ПриОткрытии</Event>\n\t</Events>\n\t<Commands>',
    )
    const findings = inspectFormBindings({ xml, module: MODULE })
    expect(findings.some((finding) => finding.kind === "missing" && finding.procedure === "ПриОткрытии")).toBe(true)
  })

  test("a command action naming a procedure the module lacks", () => {
    const xml = FORM_XML.replace("<Action>КомандаПрименить</Action>", "<Action>КомандаНесуществующая</Action>")
    const findings = inspectFormBindings({ xml, module: MODULE })
    expect(findings.some((finding) => finding.kind === "missing" && finding.detail.includes("команды"))).toBe(true)
  })
})

// Harvested from 401 form+module pairs of a БП 3.0.203.18 dump, where the
// directive was unanimous for every event: OnCreateAtServer 396/396 &НаСервере,
// OnOpen 293/293 &НаКлиенте. A wrong directive is an error, not a style.
describe("the wrong side of the wire", () => {
  test("a server event handler marked client-side is reported", () => {
    const xml = FORM_XML.replace(
      "\t<Commands>",
      '\t<Events>\n\t\t<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>\n\t</Events>\n\t<Commands>',
    )
    const module = MODULE.replace("&НаСервере\nПроцедура ПриСозданииНаСервере", "&НаКлиенте\nПроцедура ПриСозданииНаСервере")
    const findings = inspectFormBindings({ xml, module })
    expect(findings.some((finding) => finding.kind === "directive")).toBe(true)
    expect(findings.find((finding) => finding.kind === "directive")!.detail).toContain("&НаСервере")
  })

  test("the table covers the events the platform's own forms use most", () => {
    expect(KNOWN_EVENTS["ПриСозданииНаСервере"]).toEqual({
      event: "OnCreateAtServer",
      directive: "&НаСервере",
      parameters: 2,
    })
    expect(KNOWN_EVENTS["ПриОткрытии"]).toEqual({ event: "OnOpen", directive: "&НаКлиенте", parameters: 1 })
    expect(KNOWN_EVENTS["ОбработкаОповещения"]!.directive).toBe("&НаКлиенте")
  })
})

// Item handlers are named `<Item><Event>` throughout the platform's own forms
// (OnChange 1332 occurrences), so an unbound one is worth naming even though the
// item it belongs to cannot be inferred with certainty.
describe("item handlers", () => {
  test("an unbound one is named, and the item guessed from the name", () => {
    const module = `${MODULE}\n\n&НаКлиенте\nПроцедура ПолеОрганизацияПриИзменении(Элемент)\nКонецПроцедуры`
    const findings = inspectFormBindings({ xml: FORM_XML, module })
    const finding = findings.find((entry) => entry.procedure === "ПолеОрганизацияПриИзменении")
    expect(finding).toBeDefined()
    expect(finding!.detail).toContain("ПолеОрганизация")
  })

  test("a bound one is silent", () => {
    const xml = FORM_XML.replace(
      "\t<Commands>",
      '\t<Events>\n\t\t<Event name="OnChange">ПолеОрганизацияПриИзменении</Event>\n\t</Events>\n\t<Commands>',
    )
    const module = `${MODULE}\n\n&НаКлиенте\nПроцедура ПолеОрганизацияПриИзменении(Элемент)\nКонецПроцедуры`
    const findings = inspectFormBindings({ xml, module })
    expect(findings.some((finding) => finding.procedure === "ПолеОрганизацияПриИзменении")).toBe(false)
  })
})

// 2026-09-25. A report alone still costs a rebuild, and a rebuild is a DESIGNER
// launch that closes the toolkit and has to be restarted -- minutes, for one line
// of XML. So the binding is added to the source BEFORE the build, and one build
// produces a correct artefact.
describe("binding what can be bound", () => {
  const WITH_OPEN = `${MODULE}\n\n&НаКлиенте\nПроцедура ПриОткрытии(Отказ)\nКонецПроцедуры`

  test("the handler that shipped unbound is bound", () => {
    const result = bindFormEvents({ xml: FORM_XML, module: MODULE })
    expect(result.bound).toEqual([{ event: "OnCreateAtServer", procedure: "ПриСозданииНаСервере" }])
    expect(result.xml).toContain('<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>')
  })

  // Where the platform itself puts it: after </AutoCommandBar> and immediately
  // before the FORM's <ChildItems> (392 of 400 sampled forms) -- not before the
  // nested <ChildItems> inside the command bar.
  test("the block goes where the platform puts it", () => {
    const result = bindFormEvents({ xml: FORM_XML, module: MODULE })
    expect(result.xml).toContain("\t</AutoCommandBar>\n\t<Events>")
  })

  test("binding clears the findings, and a second pass changes nothing", () => {
    const once = bindFormEvents({ xml: FORM_XML, module: MODULE })
    expect(inspectFormBindings({ xml: once.xml, module: MODULE })).toEqual([])
    const twice = bindFormEvents({ xml: once.xml, module: MODULE })
    expect(twice.bound).toEqual([])
    expect(twice.xml).toBe(once.xml)
  })

  test("an existing Events block gains the entry instead of a second block", () => {
    const xml = FORM_XML.replace(
      "\t<Commands>",
      '\t<Events>\n\t\t<Event name="OnOpen">ПриОткрытии</Event>\n\t</Events>\n\t<Commands>',
    )
    const result = bindFormEvents({ xml, module: WITH_OPEN })
    expect(result.xml.match(/<Events>/g)!.length).toBe(1)
    expect(result.xml).toContain('<Event name="OnCreateAtServer">')
  })

  // Each refusal below would otherwise turn "silently does nothing" into "errors
  // in front of the user", or change behaviour the agent chose deliberately.
  test("a wrong signature is not bound", () => {
    const module = MODULE.replace("ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)", "ПриСозданииНаСервере()")
    expect(bindFormEvents({ xml: FORM_XML, module }).bound).toEqual([])
  })

  test("a Функция named like a handler is not bound", () => {
    const module = MODULE.replace(
      "Процедура ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)",
      "Функция ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)",
    )
    expect(bindFormEvents({ xml: FORM_XML, module }).bound).toEqual([])
  })

  // The item cannot be inferred with certainty from the procedure name, and
  // binding to the wrong element would change behaviour silently.
  test("an item handler is left for the report, not guessed", () => {
    const module = `${MODULE}\n\n&НаКлиенте\nПроцедура ПолеОрганизацияПриИзменении(Элемент)\nКонецПроцедуры`
    const result = bindFormEvents({ xml: FORM_XML, module })
    expect(result.bound.some((entry) => entry.procedure === "ПолеОрганизацияПриИзменении")).toBe(false)
    // It stays in the report instead, for a person to place on the right element.
    expect(
      inspectFormBindings({ xml: result.xml, module }).some(
        (finding) => finding.procedure === "ПолеОрганизацияПриИзменении",
      ),
    ).toBe(true)
  })

  test("an unrecognisable form file is left alone rather than corrupted", () => {
    const result = bindFormEvents({ xml: "<nonsense/>", module: MODULE })
    expect(result.bound).toEqual([])
    expect(result.xml).toBe("<nonsense/>")
  })

  // A file changed that the agent did not change, so it has to be told, and told
  // how to undo it.
  test("what was bound is reported, with how to undo it", () => {
    const text = describeBindings([
      { form: "Forms/Форма", bound: [{ event: "OnCreateAtServer", procedure: "ПриСозданииНаСервере" }] },
    ])!
    expect(text).toContain('<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>')
    expect(text).toContain("убери строку")
    expect(describeBindings([{ form: "Forms/Форма", bound: [] }])).toBeNull()
  })
})

// 2026-09-25, observed live. An agent editing Form.xml by hand wrote the
// procedure as a <Handler> child. A build-and-dump round trip showed what the
// platform does with it: keeps the event, canonicalises the name to
// OnCreateAtServer, and DISCARDS the child -- leaving an event with no handler.
// That is worse than the missing block, because the source reads as correct.
describe("a handler written as a child element", () => {
  const MALFORMED = FORM_XML.replace(
    "\t<Commands>",
    '\t<Events>\n\t\t<Event name="ПриСозданииНаСервере">\n\t\t\t<Handler>ПриСозданииНаСервере</Handler>\n\t\t</Event>\n\t</Events>\n\t<Commands>',
  )

  test("is straightened into the element's text", () => {
    const result = bindFormEvents({ xml: MALFORMED, module: MODULE })
    expect(result.repaired).toEqual(["ПриСозданииНаСервере"])
    expect(result.xml).toContain('<Event name="ПриСозданииНаСервере">ПриСозданииНаСервере</Event>')
    expect(result.xml).not.toContain("<Handler>")
  })

  // Without the repair the parser sees no binding and the binder would add a
  // second, correct entry beside the broken one.
  test("no duplicate entry is added beside it", () => {
    const result = bindFormEvents({ xml: MALFORMED, module: MODULE })
    expect(result.bound).toEqual([])
    expect(result.xml.match(/<Event\s/g)!.length).toBe(1)
  })

  test("the repair is reported, and named as the tool's doing", () => {
    const text = describeBindings([{ form: "Forms/Форма", bound: [], repaired: ["ПриСозданииНаСервере"] }])!
    expect(text).toContain("<Handler>")
    expect(text).toContain("это сделал инструмент, а не ты")
  })

  test("a well-formed event is left exactly as it is", () => {
    const good = FORM_XML.replace(
      "\t<Commands>",
      '\t<Events>\n\t\t<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>\n\t</Events>\n\t<Commands>',
    )
    const result = bindFormEvents({ xml: good, module: MODULE })
    expect(result.repaired).toEqual([])
    expect(result.xml).toBe(good)
  })
})

describe("parsing", () => {
  test("directives are attached to the declaration below them", () => {
    const procedures = parseModuleProcedures(MODULE)
    expect(procedures.map((procedure) => [procedure.name, procedure.directive])).toEqual([
      ["ПриСозданииНаСервере", "&НаСервере"],
      ["КомандаПрименить", "&НаКлиенте"],
      ["ПрименитьНастройкиШаблонов", "&НаСервереБезКонтекста"],
    ])
  })

  // The platform writes a BOM at the start of Module.bsl, so the first
  // declaration is easy to lose -- and it is the one that was wrong here.
  test("a BOM does not hide the first directive", () => {
    expect(parseModuleProcedures(`﻿${MODULE}`)[0]).toEqual({
      name: "ПриСозданииНаСервере",
      directive: "&НаСервере",
      line: 2,
      isProcedure: true,
      parameters: 2,
    })
  })

  test("events and actions are read out of the form", () => {
    const bindings = parseFormBindings(FORM_XML)
    expect(bindings.events).toEqual([])
    expect(bindings.actions).toEqual(["КомандаПрименить"])
  })
})

describe("the report", () => {
  test("says nothing when every form is wired", () => {
    expect(describeFormBindings([{ form: "Forms/Форма", findings: [] }])).toBeNull()
    expect(describeFormBindings([])).toBeNull()
  })

  // The explanation matters as much as the finding: the agent bound its commands
  // correctly, so it does not believe binding is something it forgets.
  test("explains why nothing else catches this", () => {
    const text = describeFormBindings([
      { form: "Forms/Форма", findings: inspectFormBindings({ xml: FORM_XML, module: MODULE }) },
    ])!
    expect(text).toContain("В конфигураторе обработчик привязывается сам")
    expect(text).toContain("мёртвый код")
    expect(text).toContain("1c_check_epf")
    expect(text).toContain("Forms/Форма")
  })
})
