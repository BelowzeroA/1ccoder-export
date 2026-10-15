// The minimal XML tree of a new external data processor (.epf) or external
// report (.erf), ready for /LoadExternalDataProcessorOrReportFromFiles.
//
// 2026-09-29, debrief16.md §16.3 item 1. With no such tree an agent has
// nothing to start from: a configuration dump never contains an external
// object, so the root element's class id appears nowhere on the machine. A run
// spent ~36 minutes on the report's class id -- copying another task's .epf,
// guessing GUIDs, grepping the disk and the platform's DLLs.
//
// Established on a scratch base (platform 8.5.1, see the test):
//   - the class ids below come from Designer dumps of a real .epf and .erf;
//   - the load CREATES the target file: no seed container is needed;
//   - the platform appends its own extension when the target's does not match
//     the root (a report built to `X.epf` lands in `X.epf.erf`), so the target
//     is named from the kind, and the loader refuses a mismatch (plugin.ts).

import { randomUUID } from "node:crypto"

export type ExternalKind = "processor" | "report"

/** The root element's class id, per kind. */
export const EXTERNAL_CLASS_IDS: Readonly<Record<ExternalKind, string>> = {
  processor: "c3831ec8-d8d5-4f93-8a22-f9bfae07327f",
  report: "e41aff26-25cf-4bb6-b6c1-3f478a75f374",
}

/** The file extension the platform gives each kind. */
export const EXTERNAL_EXTENSIONS: Readonly<Record<ExternalKind, string>> = { processor: ".epf", report: ".erf" }

/** The kind a root XML describes, from its root element; null when it is neither. */
export function externalKind(rootXml: string): ExternalKind | null {
  if (/<MetaDataObject\b[^>]*>\s*<(?:\w+:)?ExternalReport\b/.test(rootXml)) return "report"
  if (/<MetaDataObject\b[^>]*>\s*<(?:\w+:)?ExternalDataProcessor\b/.test(rootXml)) return "processor"
  return null
}

const NAMESPACES =
  'xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' +
  'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" ' +
  'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' +
  'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' +
  'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' +
  'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' +
  'xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" ' +
  'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Name of the report's composition schema template. */
export const SCHEMA_TEMPLATE = "ОсновнаяСхемаКомпоновкиДанных"

/**
 * Relative path → file content (UTF-8 with BOM, as the platform writes them).
 * The root file is `<name>.xml`; everything else sits in the `<name>/` directory beside it.
 */
export function externalSkeleton(
  kind: ExternalKind,
  object: {
    readonly name: string
    readonly synonym?: string
    readonly formatVersion?: string
    /** A processor only: a managed form «Форма» with a «Выполнить» command, as the default form. */
    readonly form?: boolean
  },
  newId: () => string = randomUUID,
): Record<string, string> {
  const head = `﻿<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject ${NAMESPACES} version="${object.formatVersion ?? "2.21"}">`
  const element = kind === "report" ? "ExternalReport" : "ExternalDataProcessor"
  const synonym = object.synonym
    ? `<Synonym>\n\t\t\t\t<v8:item>\n\t\t\t\t\t<v8:lang>ru</v8:lang>\n\t\t\t\t\t<v8:content>${escapeXml(object.synonym)}</v8:content>\n\t\t\t\t</v8:item>\n\t\t\t</Synonym>`
    : "<Synonym/>"
  const properties =
    kind === "report"
      ? [
          "<DefaultForm/>",
          "<AuxiliaryForm/>",
          `<MainDataCompositionSchema>ExternalReport.${object.name}.Template.${SCHEMA_TEMPLATE}</MainDataCompositionSchema>`,
          "<DefaultSettingsForm/>",
          "<AuxiliarySettingsForm/>",
          "<DefaultVariantForm/>",
          "<AuxiliaryVariantForm/>",
          "<VariantsStorage/>",
          "<SettingsStorage/>",
        ]
      : [object.form ? `<DefaultForm>ExternalDataProcessor.${object.name}.Form.${FORM_NAME}</DefaultForm>` : "<DefaultForm/>", "<AuxiliaryForm/>"]
  const root = [
    head,
    `\t<${element} uuid="${newId()}">`,
    "\t\t<InternalInfo>",
    "\t\t\t<xr:ContainedObject>",
    `\t\t\t\t<xr:ClassId>${EXTERNAL_CLASS_IDS[kind]}</xr:ClassId>`,
    `\t\t\t\t<xr:ObjectId>${newId()}</xr:ObjectId>`,
    "\t\t\t</xr:ContainedObject>",
    `\t\t\t<xr:GeneratedType name="${element}Object.${object.name}" category="Object">`,
    `\t\t\t\t<xr:TypeId>${newId()}</xr:TypeId>`,
    `\t\t\t\t<xr:ValueId>${newId()}</xr:ValueId>`,
    "\t\t\t</xr:GeneratedType>",
    "\t\t</InternalInfo>",
    "\t\t<Properties>",
    `\t\t\t<Name>${object.name}</Name>`,
    `\t\t\t${synonym}`,
    "\t\t\t<Comment/>",
    ...properties.map((line) => `\t\t\t${line}`),
    "\t\t</Properties>",
    kind === "report"
      ? `\t\t<ChildObjects>\n\t\t\t<Template>${SCHEMA_TEMPLATE}</Template>\n\t\t</ChildObjects>`
      : object.form
        ? `\t\t<ChildObjects>\n\t\t\t<Form>${FORM_NAME}</Form>\n\t\t</ChildObjects>`
        : "\t\t<ChildObjects/>",
    `\t</${element}>`,
    "</MetaDataObject>",
    "",
  ].join("\n")
  const module = "﻿\n"
  if (kind === "processor") {
    return {
      [`${object.name}.xml`]: root,
      [`${object.name}/Ext/ObjectModule.bsl`]: module,
      ...(object.form ? formFiles(head, object.name, newId) : {}),
    }
  }
  const template = [
    head,
    `\t<Template uuid="${newId()}">`,
    "\t\t<Properties>",
    `\t\t\t<Name>${SCHEMA_TEMPLATE}</Name>`,
    "\t\t\t<Synonym/>",
    "\t\t\t<Comment/>",
    "\t\t\t<TemplateType>DataCompositionSchema</TemplateType>",
    "\t\t</Properties>",
    "\t</Template>",
    "</MetaDataObject>",
    "",
  ].join("\n")
  return {
    [`${object.name}.xml`]: root,
    [`${object.name}/Ext/ObjectModule.bsl`]: module,
    [`${object.name}/Templates/${SCHEMA_TEMPLATE}.xml`]: template,
    [`${object.name}/Templates/${SCHEMA_TEMPLATE}/Ext/Template.xml`]: STARTER_SCHEMA,
  }
}

/** The name of the form `form: true` adds. */
export const FORM_NAME = "Форма"

// 2026-10-13, debrief18.md §18.1: asked for a processing with a form, an agent
// wrote the form's files by hand and spent an hour and four failed builds on the
// layout -- the form is a name in ChildObjects, its metadata a file of its own,
// DefaultForm a full path, the module under Ext/Form/. The files below follow a
// Designer dump of templates/blank-form.epf (platform 8.5.1) and load into a new
// file (see the test).
function formFiles(head: string, name: string, newId: () => string): Record<string, string> {
  const metadata = [
    head,
    `	<Form uuid="${newId()}">`,
    "		<Properties>",
    `			<Name>${FORM_NAME}</Name>`,
    `			<Synonym>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>${FORM_NAME}</v8:content>
				</v8:item>
			</Synonym>`,
    "			<Comment/>",
    "			<FormType>Managed</FormType>",
    "			<IncludeHelpInContents>false</IncludeHelpInContents>",
    "			<UsePurposes>",
    '				<v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value>',
    '				<v8:Value xsi:type="app:ApplicationUsePurpose">MobilePlatformApplication</v8:Value>',
    "			</UsePurposes>",
    "			<UseInInterfaceCompatibilityMode>Any</UseInInterfaceCompatibilityMode>",
    "			<ExtendedPresentation/>",
    "		</Properties>",
    "	</Form>",
    "</MetaDataObject>",
    "",
  ].join("\n")
  const layout = `﻿<?xml version="1.0" encoding="UTF-8"?>
<Form ${FORM_NAMESPACES} version="2.21">
	<AutoCommandBar name="ФормаКоманднаяПанель" id="-1">
		<ChildItems>
			<Button name="ФормаВыполнить" id="11">
				<Type>CommandBarButton</Type>
				<CommandName>Form.Command.Выполнить</CommandName>
				<ExtendedTooltip name="ФормаВыполнитьРасширеннаяПодсказка" id="12"/>
			</Button>
		</ChildItems>
	</AutoCommandBar>
	<Attributes>
		<Attribute name="Объект" id="1">
			<Type>
				<v8:Type>cfg:ExternalDataProcessorObject.${name}</v8:Type>
			</Type>
			<MainAttribute>true</MainAttribute>
		</Attribute>
	</Attributes>
	<Commands>
		<Command name="Выполнить" id="1">
			<Title>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>Выполнить</v8:content>
				</v8:item>
			</Title>
			<Action>КомандаВыполнить</Action>
		</Command>
	</Commands>
</Form>
`
  const formModule = [
    "﻿&НаСервереБезКонтекста",
    "Процедура ВыполнитьНаСервере()",
    "КонецПроцедуры",
    "",
    "&НаКлиенте",
    "Процедура КомандаВыполнить(Команда)",
    "	ВыполнитьНаСервере();",
    "КонецПроцедуры",
    "",
  ].join("\n")
  return {
    [`${name}/Forms/${FORM_NAME}.xml`]: metadata,
    [`${name}/Forms/${FORM_NAME}/Ext/Form.xml`]: layout,
    [`${name}/Forms/${FORM_NAME}/Ext/Form/Module.bsl`]: formModule,
  }
}

const FORM_NAMESPACES =
  'xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' +
  'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" ' +
  'xmlns:dcssch="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" ' +
  'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' +
  'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' +
  'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' +
  'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' +
  'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'

// A schema that loads, composes and shows the shape of everything a report
// needs; each part below was found missing by trial in debrief16.md §16.1:
//   - `dataSource` inside the dataset, `totalField` as the resource;
//   - the detail group NESTED inside the grouping, and an explicit selection
//     at each level (otherwise the composer drops the fields and the totals);
//   - a required parameter (`denyIncompleteValues`) with a user setting;
//   - a minimum width on the numeric field (otherwise «#####» in small reports).
const STARTER_SCHEMA = `﻿<?xml version="1.0" encoding="UTF-8"?>
<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:dcscom="http://v8.1c.ru/8.1/data-composition-system/common" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<dataSource>
		<name>ИсточникДанных1</name>
		<dataSourceType>Local</dataSourceType>
	</dataSource>
	<dataSet xsi:type="DataSetQuery">
		<name>НаборДанных1</name>
		<field xsi:type="DataSetFieldField">
			<dataPath>Группа</dataPath>
			<field>Группа</field>
		</field>
		<field xsi:type="DataSetFieldField">
			<dataPath>Сумма</dataPath>
			<field>Сумма</field>
			<appearance>
				<dcscor:item xsi:type="dcsset:SettingsParameterValue">
					<dcscor:parameter>Формат</dcscor:parameter>
					<dcscor:value xsi:type="v8:LocalStringType">
						<v8:item>
							<v8:lang>ru</v8:lang>
							<v8:content>ЧДЦ=2</v8:content>
						</v8:item>
					</dcscor:value>
				</dcscor:item>
				<dcscor:item xsi:type="dcsset:SettingsParameterValue">
					<dcscor:parameter>МинимальнаяШирина</dcscor:parameter>
					<dcscor:value xsi:type="xs:decimal">15</dcscor:value>
				</dcscor:item>
			</appearance>
		</field>
		<dataSource>ИсточникДанных1</dataSource>
		<query>ВЫБРАТЬ
	"Пример" КАК Группа,
	&amp;Коэффициент * 1 КАК Сумма</query>
		<autoFillFields>true</autoFillFields>
	</dataSet>
	<totalField>
		<dataPath>Сумма</dataPath>
		<expression>Сумма(Сумма)</expression>
	</totalField>
	<parameter>
		<name>Коэффициент</name>
		<title xsi:type="v8:LocalStringType">
			<v8:item>
				<v8:lang>ru</v8:lang>
				<v8:content>Коэффициент</v8:content>
			</v8:item>
		</title>
		<valueType>
			<v8:Type>xs:decimal</v8:Type>
			<v8:NumberQualifiers>
				<v8:Digits>10</v8:Digits>
				<v8:FractionDigits>2</v8:FractionDigits>
				<v8:AllowedSign>Any</v8:AllowedSign>
			</v8:NumberQualifiers>
		</valueType>
		<value xsi:type="xs:decimal">1</value>
		<useRestriction>false</useRestriction>
		<denyIncompleteValues>true</denyIncompleteValues>
	</parameter>
	<settingsVariant>
		<dcsset:name>Основной</dcsset:name>
		<dcsset:presentation xsi:type="xs:string">Основной</dcsset:presentation>
		<dcsset:settings>
			<dcsset:selection>
				<dcsset:item xsi:type="dcsset:SelectedItemField">
					<dcsset:field>Сумма</dcsset:field>
				</dcsset:item>
			</dcsset:selection>
			<dcsset:dataParameters>
				<dcscor:item xsi:type="dcsset:SettingsParameterValue">
					<dcscor:parameter>Коэффициент</dcscor:parameter>
					<dcscor:value xsi:type="xs:decimal">1</dcscor:value>
					<dcsset:userSettingID>${"a1b2c3d4-0000-4000-8000-000000000001"}</dcsset:userSettingID>
				</dcscor:item>
			</dcsset:dataParameters>
			<dcsset:item xsi:type="dcsset:StructureItemGroup">
				<dcsset:groupItems>
					<dcsset:item xsi:type="dcsset:GroupItemField">
						<dcsset:field>Группа</dcsset:field>
						<dcsset:groupType>Items</dcsset:groupType>
						<dcsset:periodAdditionType>None</dcsset:periodAdditionType>
						<dcsset:periodAdditionBegin xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionBegin>
						<dcsset:periodAdditionEnd xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionEnd>
					</dcsset:item>
				</dcsset:groupItems>
				<dcsset:order>
					<dcsset:item xsi:type="dcsset:OrderItemAuto"/>
				</dcsset:order>
				<dcsset:selection>
					<dcsset:item xsi:type="dcsset:SelectedItemField">
						<dcsset:field>Группа</dcsset:field>
					</dcsset:item>
					<dcsset:item xsi:type="dcsset:SelectedItemField">
						<dcsset:field>Сумма</dcsset:field>
					</dcsset:item>
				</dcsset:selection>
				<dcsset:item xsi:type="dcsset:StructureItemGroup">
					<dcsset:order>
						<dcsset:item xsi:type="dcsset:OrderItemAuto"/>
					</dcsset:order>
					<dcsset:selection>
						<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
					</dcsset:selection>
				</dcsset:item>
			</dcsset:item>
		</dcsset:settings>
	</settingsVariant>
</DataCompositionSchema>
`
