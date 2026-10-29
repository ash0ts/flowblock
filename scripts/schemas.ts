import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AgentActionSchema, AgentResponseSchema, GearSchema, IntentSchema, OverridesSchema, PlanVersionSchema, SceneSchema, TakeAnalysisSchema, schemaVersion } from '../src/domain';
import { RoomCaptureImportSchema, ARPathExportSchema, RecordingCropMetadataSchema, RecipeReviewMetadataSchema } from '../src/domain/native-companion';
import { AnalyzeSchema, UploadSchema, ProjectSchema } from '../src/server/api-contracts';

const planning = z.object({ scene: SceneSchema, gear: GearSchema, intent: IntentSchema, prompt: z.string().max(4000).optional() }).strict();
const revision = z.object({ plan: PlanVersionSchema, analysis: z.object({ jobId: z.string().uuid() }), overrides: OverridesSchema.optional(), findingIds: z.array(z.string()).optional() }).strict();
const schemas = { scene: SceneSchema, gear: GearSchema, intent: IntentSchema, overrides: OverridesSchema, plan: PlanVersionSchema, 'agent-action': AgentActionSchema, 'agent-response': AgentResponseSchema, 'take-analysis': TakeAnalysisSchema, 'planning-request': planning, 'upload-request': UploadSchema, 'analysis-request': AnalyzeSchema, 'project-request': ProjectSchema, 'revision-request': revision, 'room-capture-import': RoomCaptureImportSchema, 'ar-path-export': ARPathExportSchema, 'recording-crop-metadata': RecordingCropMetadataSchema, 'recipe-review-metadata': RecipeReviewMetadataSchema };
const directory = resolve('docs/schemas');
await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  await writeFile(resolve(directory, `${name}.json`), `${JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://flowblock.local/schemas/${schemaVersion}/${name}.json` }, null, 2)}\n`);
}
process.stdout.write(`Generated ${Object.keys(schemas).length} version ${schemaVersion} JSON schemas.\n`);

const ref = (name: keyof typeof schemas) => ({ $ref: `#/components/schemas/${name}` });
const requestBody = (name: keyof typeof schemas) => ({ required: true, content: { 'application/json': { schema: ref(name) } } });
const responses = {
  '200': { description: 'Successful operation; server-derived plan and validation fields are authoritative.' },
  '202': { description: 'Job accepted or already running. Poll GET /api/jobs/{id}.' },
  '400': { description: 'Malformed JSON or contract validation failed.' },
  '401': { description: 'Sign-in required outside explicit loopback local mode.' },
  '403': { description: 'Cross-origin write rejected.' },
  '404': { description: 'Resource not found for this owner.' },
  '409': { description: 'Stale version, upload state, or idempotency input conflict.' },
  '422': { description: 'Geometry or evidence does not permit this operation.' },
  '429': { description: 'Daily account quota reached.' },
  '503': { description: 'Required local service is unavailable; keep the draft and retry.' },
};
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const key = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'The same owner and key must have identical request inputs.' };
const openapi = {
  openapi: '3.1.0', info: { title: 'FlowBlock API', version: schemaVersion, description: 'Local planning with owned project snapshots, explicit media completion, leased analysis jobs, and accepted evidence-linked revisions.' }, servers: [{ url: 'http://127.0.0.1:3037' }],
  security: [{ session: [] }],
  paths: {
    '/api/status': { get: { operationId: 'status', security: [], responses: { '200': { description: 'Configured capabilities and recorded training state, without credentials.' } } } },
    '/api/plans': { post: { operationId: 'planShot', parameters: [key], requestBody: requestBody('planning-request'), responses } },
    '/api/uploads': { post: { operationId: 'createUpload', requestBody: requestBody('upload-request'), responses } },
    '/api/takes/{id}/upload': { put: { operationId: 'uploadLocalBytes', parameters: [id], requestBody: { required: true, content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } } }, responses } },
    '/api/uploads/{id}/complete': { post: { operationId: 'verifyUpload', parameters: [id], responses } },
    '/api/takes/{id}/analyze': { post: { operationId: 'analyzeTake', parameters: [id, key], requestBody: requestBody('analysis-request'), responses } },
    '/api/jobs/{id}': { get: { operationId: 'readJob', parameters: [id], responses }, delete: { operationId: 'cancelJob', parameters: [id], responses } },
    '/api/takes/{id}/media': { get: { operationId: 'readOwnedMedia', parameters: [id, { name: 'artifact', in: 'query', schema: { type: 'string' }, description: 'original, proxy, or an evidence object key already present in this take’s saved analysis.' }, { name: 'Range', in: 'header', schema: { type: 'string' }, description: 'One HTTP bytes range.' }], responses: { ...responses, '206': { description: 'Partial byte range.' }, '416': { description: 'Invalid byte range.' } } } },
    '/api/takes/{id}': { delete: { operationId: 'deleteTake', parameters: [id], responses } },
    '/api/revisions': { post: { operationId: 'proposeRevision', requestBody: requestBody('revision-request'), responses } },
    '/api/revisions/{id}/accept': { post: { operationId: 'acceptRevision', parameters: [id], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['currentPlanId'], properties: { currentPlanId: { type: 'string' } } } } } }, responses } },
    '/api/projects': { post: { operationId: 'saveProjectVersion', requestBody: requestBody('project-request'), responses }, get: { operationId: 'listOwnedProjects', responses } },
    '/api/shares': { post: { operationId: 'shareSnapshot', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['plan'], properties: { plan: ref('plan') } } } } }, responses } },
    '/api/shares/{token}': { delete: { operationId: 'revokeShare', parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses } },
  },
  components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'authjs.session-token' } }, schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)])) },
};
await writeFile(resolve('docs/openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
process.stdout.write('Generated OpenAPI 3.1 operation reference.\n');
