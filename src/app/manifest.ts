import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return { name: 'FlowBlock', short_name: 'FlowBlock', description: 'A product shot workspace for solo creators.', start_url: '/', display: 'standalone', background_color: '#f5f4ed', theme_color: '#163e35', icons: [{src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any'}] };
}
