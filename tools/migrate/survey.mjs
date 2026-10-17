import {parse} from 'node-html-parser';
import {readFileSync} from 'node:fs';
const m=JSON.parse(readFileSync('tools/migrate/raw/manifest.json','utf8'));
const o={blockTextElements:{script:true,noscript:true,style:true}};
const c={};const inc=(k,n=1)=>c[k]=(c[k]||0)+n;
const hosts={},preCls={},preParents={},noTags=[],cats={},langHints={},linkHosts={},iframes=[];
for(const [p,e] of Object.entries(m)){
 const r=parse(readFileSync('tools/migrate/'+e.file,'utf8'),o);
 const b=r.querySelector('.post-body');
 const tags=r.querySelectorAll('.post-tags a').map(a=>a.text.trim());
 const cs=r.querySelectorAll('.post-info .post-category a').map(a=>a.text.trim());
 cs.forEach(x=>cats[x]=(cats[x]||0)+1);
 if(!tags.length&&!cs.length) noTags.push(p);
 for(const img of b.querySelectorAll('img')){const s=img.getAttribute('src')||'';let h=s.startsWith('/')?'(relative) '+s.split('?')[0]:(s.match(/^https?:\/\/([^/]+)/)||[,'other:'+s.slice(0,30)])[1];hosts[h]=(hosts[h]||0)+1;}
 for(const pre of b.querySelectorAll('pre')){const k=(pre.getAttribute('class')||'')+(pre.getAttribute('style')?' [style]':'');preCls[k]=(preCls[k]||0)+1;const par=pre.parentNode;const pk=par.tagName+'.'+(par.getAttribute&&par.getAttribute('class')||'')+(par.getAttribute&&par.getAttribute('id')?'#id':'');preParents[pk]=(preParents[pk]||0)+1;}
 for(const a of b.querySelectorAll('a[href]')){const h=a.getAttribute('href');const k=h.startsWith('/')?'(root) '+h.split('/')[1].split('?')[0]:h.startsWith('#')?'#':(h.match(/^(https?:)?\/\/([^/]+)/)||[,,'other:'+h.slice(0,25)])[2];linkHosts[k]=(linkHosts[k]||0)+1;}
 b.querySelectorAll('iframe,object,embed,script').forEach(x=>iframes.push(p+' '+x.tagName+' '+(x.getAttribute('src')||x.getAttribute('data')||'').slice(0,60)));
 b.querySelectorAll('[style]').forEach(()=>inc('elements with style attr'));
 b.querySelectorAll('table').forEach(()=>inc('tables'));
 b.querySelectorAll('h1').forEach(()=>inc('h1 in body'));
 b.querySelectorAll('h2,h3,h4').forEach(()=>inc('h2-h4'));
 b.querySelectorAll('font,center,span[style]').forEach(()=>inc('font/center/styled span'));
 b.querySelectorAll('div.wlWriterEditableSmartContent,div.wlWriterSmartContent').forEach(()=>inc('WLW smartcontent divs'));
 b.querySelectorAll('code').forEach(()=>inc('code elements'));
}
const show=(t,o)=>{console.log('== '+t);Object.entries(o).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('  '+v+'  '+k))};
console.log(c);show('image hosts',hosts);show('pre class/style',preCls);show('pre parents',preParents);show('categories',cats);show('link targets',linkHosts);
console.log('== no tags/cats',noTags.length);noTags.forEach(x=>console.log('  '+x));console.log('== embeds');iframes.forEach(x=>console.log('  '+x));
