/**
 * A small hand-written IFC4 model for unit and value-kind tests: things the
 * sample models do not have. Neutral, invented data.
 *
 * Project units: millimetres, m², m³, kg, degrees, and a derived kN/m². No
 * time unit, so a duration's unit is "not stated".
 *
 * Three walls share `Pset_Fixture.Width`: A and C in the project's
 * millimetres, B with its own unit (metres) — a mixed-unit parameter. Wall A
 * also carries one property of every kind (enumerated, list, bounded, table),
 * per-property units (an inch) and quantities, one with its own unit (dm³).
 *
 * `NO_UNITS_IFC` is a model that states no units at all.
 */

const header = (schema: string): string[] => [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('units-fixture.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  `FILE_SCHEMA(('${schema}'));`,
  'ENDSEC;',
  'DATA;',
];
const footer = ['ENDSEC;', 'END-ISO-10303-21;', ''];

/** A 22-character IFC GlobalId, unique per n. */
const g = (n: number): string => `'${`0${String(n).padStart(21, '0')}`}'`;

export const WALL_A = 100;
export const WALL_B = 200;
export const WALL_C = 300;

export const UNITS_IFC = [
  ...header('IFC4'),
  `#1=IFCPROJECT(${g(1)},$,'Fixture project',$,$,$,$,$,#10);`,
  '#10=IFCUNITASSIGNMENT((#11,#12,#13,#14,#15,#16));',
  '#11=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '#12=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
  '#13=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);',
  '#14=IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);',
  '#15=IFCDERIVEDUNIT((#20,#21),.PLANARFORCEUNIT.,$);',
  '#20=IFCDERIVEDUNITELEMENT(#22,1);',
  '#21=IFCDERIVEDUNITELEMENT(#23,-2);',
  '#22=IFCSIUNIT(*,.FORCEUNIT.,.KILO.,.NEWTON.);',
  '#23=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  "#16=IFCCONVERSIONBASEDUNIT(#30,.PLANEANGLEUNIT.,'degree',#31);",
  '#30=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);',
  '#31=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.0174532925199433),#32);',
  '#32=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);',
  "#40=IFCCONVERSIONBASEDUNIT(#30,.LENGTHUNIT.,'inch',#41);",
  '#41=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.0254),#23);',
  '#42=IFCSIUNIT(*,.VOLUMEUNIT.,.DECI.,.CUBIC_METRE.);',

  // Wall A: every kind of value.
  `#${WALL_A}=IFCWALL(${g(100)},$,'Wall A',$,$,$,$,$,$);`,
  `#101=IFCPROPERTYSET(${g(101)},$,'Pset_Fixture',$,(#110,#111,#112,#113,#114,#115,#116,#117,#118,#119));`,
  "#110=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),$);",
  "#111=IFCPROPERTYSINGLEVALUE('Load',$,IFCPLANARFORCEMEASURE(5.),$);",
  "#112=IFCPROPERTYSINGLEVALUE('Duration',$,IFCTIMEMEASURE(3.),$);",
  "#113=IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('NEW')),#120);",
  "#120=IFCPROPERTYENUMERATION('PEnum_FixtureStatus',(IFCLABEL('NEW'),IFCLABEL('EXISTING')),$);",
  "#114=IFCPROPERTYLISTVALUE('Points',$,(IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.)),$);",
  "#115=IFCPROPERTYBOUNDEDVALUE('Range',$,IFCLENGTHMEASURE(10.),IFCLENGTHMEASURE(1.),$,$);",
  "#116=IFCPROPERTYTABLEVALUE('Table',$,(IFCREAL(1.),IFCREAL(2.)),(IFCREAL(10.),IFCREAL(20.)),$,$,$,$);",
  "#117=IFCPROPERTYSINGLEVALUE('Spacing',$,IFCPOSITIVELENGTHMEASURE(12.),#40);",
  "#118=IFCPROPERTYSINGLEVALUE('Slope',$,IFCPLANEANGLEMEASURE(2.5),$);",
  "#119=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('A-1'),$);",
  `#102=IFCRELDEFINESBYPROPERTIES(${g(102)},$,$,$,(#${WALL_A}),#101);`,
  `#103=IFCELEMENTQUANTITY(${g(103)},$,'Qto_Fixture',$,$,(#130,#131,#132));`,
  "#130=IFCQUANTITYLENGTH('Length',$,$,4500.,$);",
  "#131=IFCQUANTITYAREA('NetArea',$,$,12.5,$);",
  "#132=IFCQUANTITYVOLUME('NetVolume',$,#42,2500.,$);",
  `#104=IFCRELDEFINESBYPROPERTIES(${g(104)},$,$,$,(#${WALL_A}),#103);`,

  // Wall B: the same width, in metres by its own unit.
  `#${WALL_B}=IFCWALL(${g(200)},$,'Wall B',$,$,$,$,$,$);`,
  `#201=IFCPROPERTYSET(${g(201)},$,'Pset_Fixture',$,(#210,#211));`,
  "#210=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(0.3),#23);",
  "#211=IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('EXISTING')),#120);",
  `#202=IFCRELDEFINESBYPROPERTIES(${g(202)},$,$,$,(#${WALL_B}),#201);`,
  `#203=IFCELEMENTQUANTITY(${g(203)},$,'Qto_Fixture',$,$,(#230));`,
  "#230=IFCQUANTITYLENGTH('Length',$,$,3000.,$);",
  `#204=IFCRELDEFINESBYPROPERTIES(${g(204)},$,$,$,(#${WALL_B}),#203);`,

  // Wall C: the same width, in the project's millimetres.
  `#${WALL_C}=IFCWALL(${g(300)},$,'Wall C',$,$,$,$,$,$);`,
  `#301=IFCPROPERTYSET(${g(301)},$,'Pset_Fixture',$,(#310));`,
  "#310=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(250.),$);",
  `#302=IFCRELDEFINESBYPROPERTIES(${g(302)},$,$,$,(#${WALL_C}),#301);`,
  ...footer,
].join('\n');

/** A model whose project states no units: its lengths are "unit not stated". */
export const NO_UNITS_IFC = [
  ...header('IFC2X3'),
  `#1=IFCPROJECT(${g(1)},$,'Fixture project',$,$,$,$,$,$);`,
  `#${WALL_A}=IFCWALL(${g(100)},$,'Wall A',$,$,$,$,$);`,
  `#101=IFCPROPERTYSET(${g(101)},$,'Pset_Fixture',$,(#110,#111));`,
  "#110=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),$);",
  "#111=IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('NEW'),IFCLABEL('TEMPORARY')),$);",
  `#102=IFCRELDEFINESBYPROPERTIES(${g(102)},$,$,$,(#${WALL_A}),#101);`,
  ...footer,
].join('\n');
