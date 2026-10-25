import {expect,it} from 'vitest';
import {dmSourceSequence,newerDMSource,sortDMBySource} from './dmSourceOrder';
const m=(id:string,source_sequence?:string,created_at='2026-10-25T11:11:44Z')=>({id,source_sequence,created_at});
it('orders same-second and inverted clock messages by exact authoritative sequence',()=>{
 expect(sortDMBySource([m('z','1','2099'),m('a','3','2000'),m('b','2','2020')]).map(x=>x.id)).toEqual(['z','b','a']);
 expect(newerDMSource(m('old','1','2099'),m('new','2','2000'))).toBe(false);
});
it('retains legacy fallback and stable mixed slots without a nontransitive comparator',()=>{
 expect(sortDMBySource([m('b',undefined,'2021'),m('a',undefined,'2020')]).map(x=>x.id)).toEqual(['a','b']);
 expect(sortDMBySource([m('known2','2','2020'),m('legacy',undefined,'2021'),m('known1','1','2022')]).map(x=>x.id)).toEqual(['known1','legacy','known2']);
});
it('keeps full BIGINT precision and rejects nonauthoritative or invalid values',()=>{
 expect(dmSourceSequence('9007199254740993')).toBe(9007199254740993n);expect(dmSourceSequence('9223372036854775807')).toBe(9223372036854775807n);
 for(const value of ['0','-1','1.5','01','9223372036854775808',9007199254740992,null,undefined])expect(dmSourceSequence(value)).toBeNull();
 expect(sortDMBySource([m('higher','9007199254740993'),m('lower','9007199254740992')]).map(x=>x.id)).toEqual(['lower','higher']);
});
