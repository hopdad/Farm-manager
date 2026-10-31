import { describe, expect, test } from 'vitest';
import { AempXmlError, parseXml, xmlToObject } from './xml';

describe('the ISO 15143-3 XML reader', () => {
  test('elements, attributes, repeated children, namespaces, entities, CDATA and comments', () => {
    const doc = `﻿<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<iso:Fleet xmlns:iso="http://standards.iso.org/iso/15143/-3" version='1' snapshotTime="2026-10-30T14:00:00Z">
  <iso:Links><iso:rel>self</iso:rel><iso:href>https://x.example/Fleet/1?a=1&amp;b=2</iso:href></iso:Links>
  <iso:Links><iso:rel>next</iso:rel><iso:href>https://x.example/Fleet/2</iso:href></iso:Links>
  <iso:Equipment>
    <iso:EquipmentHeader><iso:Model><![CDATA[SVL97-2 <track>]]></iso:Model><iso:PIN>A&#66;&#x43;</iso:PIN></iso:EquipmentHeader>
    <iso:Location datetime="2026-10-30T13:00:00Z"><iso:Latitude> 41.9 </iso:Latitude><iso:Longitude>-84</iso:Longitude></iso:Location>
    <iso:Empty/>
  </iso:Equipment>
</iso:Fleet>`;
    expect(xmlToObject(doc)).toEqual({
      Fleet: {
        version: '1',
        snapshotTime: '2026-10-30T14:00:00Z',
        Links: [
          { rel: 'self', href: 'https://x.example/Fleet/1?a=1&b=2' },
          { rel: 'next', href: 'https://x.example/Fleet/2' },
        ],
        Equipment: {
          EquipmentHeader: { Model: 'SVL97-2 <track>', PIN: 'ABC' },
          Location: { datetime: '2026-10-30T13:00:00Z', Latitude: '41.9', Longitude: '-84' },
          Empty: '',
        },
      },
    });
  });

  test('a one-element list stays a value (the schemas make it an array)', () => {
    expect(xmlToObject('<A><B>1</B></A>')).toEqual({ A: { B: '1' } });
    expect(xmlToObject('<A><B>1</B><B>2</B><B>3</B></A>')).toEqual({ A: { B: ['1', '2', '3'] } });
  });

  test('malformed documents and DOCTYPEs are refused', () => {
    for (const bad of [
      '',
      'just text',
      '<A><B></A>',
      '<A>',
      '<A></A><B></B>',
      '<A x=1></A>',
      '<A>&nbsp;</A>',
      '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
      '<A><!-- open</A>',
    ]) {
      expect(() => parseXml(bad), bad).toThrow(AempXmlError);
    }
  });

  test('nesting is bounded', () => {
    const deep = `${'<a>'.repeat(100)}${'</a>'.repeat(100)}`;
    expect(() => parseXml(deep)).toThrow(/nested too deeply/);
  });
});
