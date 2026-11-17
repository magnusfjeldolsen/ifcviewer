/**
 * Small hand-written IFC files for tests: one project, one shared box body,
 * and one product of each listed type carrying it. Written as STEP text so a
 * test can cover a schema (IFC4, IFC4X3) we have no real sample of.
 *
 * Each product line gives the attributes its schema defines, in order; the
 * attribute lists come from the IFC4 ADD2 TC1 and IFC4X3 ADD2 specifications.
 */

export interface SyntheticProduct {
  /** STEP entity name, e.g. `IFCWALL`. */
  entity: string;
  /** Attributes after IfcProduct's seven, as STEP text. */
  tail: string[];
  /** Give it the box body (true) or no Representation at all. */
  body?: boolean;
}

/** A 22-character IFC GlobalId, unique per n. */
function guid(n: number): string {
  return `0${String(n).padStart(21, '0')}`;
}

export function syntheticIfc(schema: 'IFC4' | 'IFC4X3_ADD2', products: SyntheticProduct[]): string {
  const lines = [
    "#1=IFCPROJECT('" + guid(1) + "',$,'P',$,$,$,$,(#20),#10);",
    '#10=IFCUNITASSIGNMENT((#11));',
    '#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);",
    '#21=IFCAXIS2PLACEMENT3D(#22,$,$);',
    '#22=IFCCARTESIANPOINT((0.,0.,0.));',
    '#30=IFCLOCALPLACEMENT($,#21);',
    '#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,#41,1.,1.);',
    '#41=IFCAXIS2PLACEMENT2D(#42,$);',
    '#42=IFCCARTESIANPOINT((0.,0.));',
    '#43=IFCDIRECTION((0.,0.,1.));',
    '#44=IFCEXTRUDEDAREASOLID(#40,#21,#43,1.);',
    "#45=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#44));",
    '#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));',
  ];
  products.forEach((p, i) => {
    const id = 100 + i;
    const rep = p.body === false ? '$' : '#46';
    const attrs = [`'${guid(id)}'`, '$', `'${p.entity}'`, '$', '$', '#30', rep, ...p.tail];
    lines.push(`#${id}=${p.entity}(${attrs.join(',')});`);
  });
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('synthetic.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/**
 * IfcProduct subtypes worth covering in IFC4: the ordinary (a wall, a proxy),
 * the excluded (openings, spaces), and the ones easy to get wrong (annotation,
 * voiding feature, spatial zone, external spatial element, geographic
 * element, virtual element, site).
 */
export const IFC4_PRODUCTS: SyntheticProduct[] = [
  { entity: 'IFCWALL', tail: ['$', '$'] },
  { entity: 'IFCBUILDINGELEMENTPROXY', tail: ['$', '$'] },
  { entity: 'IFCANNOTATION', tail: [] },
  { entity: 'IFCOPENINGELEMENT', tail: ['$', '.OPENING.'] },
  { entity: 'IFCOPENINGSTANDARDCASE', tail: ['$', '.OPENING.'] },
  { entity: 'IFCVOIDINGFEATURE', tail: ['$', '.CUTOUT.'] },
  { entity: 'IFCSPACE', tail: ['$', '.ELEMENT.', '.SPACE.', '$'] },
  { entity: 'IFCSPATIALZONE', tail: ['$', '.NOTDEFINED.'] },
  { entity: 'IFCEXTERNALSPATIALELEMENT', tail: ['$', '.EXTERNAL.'] },
  { entity: 'IFCGEOGRAPHICELEMENT', tail: ['$', '.TERRAIN.'] },
  { entity: 'IFCVIRTUALELEMENT', tail: ['$'] },
  { entity: 'IFCSITE', tail: ['$', '.ELEMENT.', '$', '$', '$', '$', '$'] },
  { entity: 'IFCBUILDINGSTOREY', tail: ['$', '.ELEMENT.', '0.'] },
  { entity: 'IFCWALL', tail: ['$', '$'], body: false },
];

/** The same for IFC4X3, plus infrastructure: alignment, referent, course, bridge. */
export const IFC4X3_PRODUCTS: SyntheticProduct[] = [
  { entity: 'IFCWALL', tail: ['$', '$'] },
  { entity: 'IFCBUILDINGELEMENTPROXY', tail: ['$', '$'] },
  { entity: 'IFCANNOTATION', tail: ['$'] },
  { entity: 'IFCOPENINGELEMENT', tail: ['$', '.OPENING.'] },
  { entity: 'IFCVOIDINGFEATURE', tail: ['$', '.CUTOUT.'] },
  { entity: 'IFCSPACE', tail: ['$', '.ELEMENT.', '.SPACE.', '$'] },
  { entity: 'IFCSPATIALZONE', tail: ['$', '.NOTDEFINED.'] },
  { entity: 'IFCEXTERNALSPATIALELEMENT', tail: ['$', '.EXTERNAL.'] },
  { entity: 'IFCGEOGRAPHICELEMENT', tail: ['$', '.TERRAIN.'] },
  { entity: 'IFCVIRTUALELEMENT', tail: ['$', '$'] },
  { entity: 'IFCALIGNMENT', tail: ['$'] },
  { entity: 'IFCREFERENT', tail: ['$'] },
  { entity: 'IFCCOURSE', tail: ['$', '$'] },
  { entity: 'IFCBRIDGE', tail: ['$', '.ELEMENT.', '$'] },
  { entity: 'IFCSITE', tail: ['$', '.ELEMENT.', '$', '$', '$', '$', '$'] },
  { entity: 'IFCWALL', tail: ['$', '$'], body: false },
];
