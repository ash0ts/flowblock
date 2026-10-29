import Link from 'next/link';
import type { PlanVersion } from '@/domain';
export function ShotCard({plan,label}:{plan:PlanVersion;label:string}){
 const xs=plan.scene.boundary.map(p=>p.x),zs=plan.scene.boundary.map(p=>p.z);const minX=Math.min(...xs),minZ=Math.min(...zs),w=Math.max(...xs)-minX,h=Math.max(...zs)-minZ;
 return <main style={{maxWidth:900,margin:'48px auto',padding:24}}><Link href="/">FlowBlock</Link><p>{label} · Read only</p><h1>{plan.name}</h1><p>{plan.intent.brief}</p><p>{plan.validation.valid?'Validated against the supplied geometry':'This draft needs adjustment'} · {plan.durationSeconds}s · {plan.gear.lens.focalLengthMm}mm</p>
 <svg viewBox={`${minX-.3} ${minZ-.3} ${w+.6} ${h+.6}`} role="img" aria-label="Overhead shot plan" style={{width:'100%',maxHeight:520,background:'#f4f1e9',borderRadius:16}}>
 <polygon points={plan.scene.boundary.map(p=>`${p.x},${p.z}`).join(' ')} fill="none" stroke="#8c948b" strokeWidth=".025"/>
 {plan.scene.obstacles.map(o=><rect key={o.id} x={o.center.x-o.width/2} y={o.center.z-o.depth/2} width={o.width} height={o.depth} transform={`rotate(${o.yawDeg} ${o.center.x} ${o.center.z})`} fill="#dcd9cf" stroke="#a3a398" strokeWidth=".025"/>)}
 <polyline points={plan.keyframes.map(k=>`${k.position.x},${k.position.z}`).join(' ')} fill="none" stroke="#245d4e" strokeWidth=".05" strokeDasharray=".12 .09"/>
 <circle cx={plan.path.start.x} cy={plan.path.start.z} r=".09" fill="#245d4e"/><rect x={plan.path.end.x-.08} y={plan.path.end.z-.08} width=".16" height=".16" fill="#245d4e"/>
 <circle cx={plan.scene.subject.center.x} cy={plan.scene.subject.center.z} r=".13" fill="#c36e43"/>
 </svg><p>Path length: {plan.arcLength.toFixed(2)} m. Camera height: {plan.cameraHeight.toFixed(2)} m. Check the real space before rehearsing.</p>
 <ul>{plan.validation.violations.map((v,i)=><li key={i}>{v.message}</li>)}</ul><p>Footage is private and is not included in this card.</p></main>;
}
