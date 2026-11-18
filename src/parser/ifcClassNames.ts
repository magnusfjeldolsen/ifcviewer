/**
 * IFC type code → class name as the inspector shows it (`IfcSlab`).
 *
 * The name must not come from the web-ifc line object's constructor: the
 * production build minifies web-ifc inside the worker chunk and renames every
 * class, so `constructor.name` reads `lg` or `_g` there while the dev server
 * still reads `IfcSlab` (issue #90).
 *
 * web-ifc's `GetNameFromTypeCode` is the source of truth instead. It answers
 * from a table inside the WASM module, so minification cannot touch it, and
 * for every entity class of IFC2X3, IFC4 and IFC4X3 it returns exactly the
 * mixed-case name the dev build showed (tests/ifc-class-names.test.ts checks
 * every one, so a web-ifc upgrade that changes this fails a test).
 */

import { ifcClassFromTypeCode } from '../inspector/repository/propertyNormalizer';

/** The part of `IfcAPI` the namer depends on. */
export interface ClassNameApi {
  GetNameFromTypeCode(type: number): string;
}

export type IfcClassNamer = (typeCode: number) => string;

/** What web-ifc 0.0.77 answers for a code it doesn't know. */
const WEB_IFC_UNKNOWN_TYPE = '<web-ifc-type-unknown>';

/**
 * Name type codes through web-ifc. A code web-ifc doesn't know gets the
 * recognisable placeholder from `ifcClassFromTypeCode`, never a guess.
 */
export function createIfcClassNamer(api: ClassNameApi): IfcClassNamer {
  return (typeCode) => {
    if (!typeCode) return ifcClassFromTypeCode(typeCode);
    let name: string;
    try {
      name = api.GetNameFromTypeCode(typeCode) ?? '';
    } catch {
      name = '';
    }
    if (!name || name === WEB_IFC_UNKNOWN_TYPE) return ifcClassFromTypeCode(typeCode);
    return name;
  };
}
