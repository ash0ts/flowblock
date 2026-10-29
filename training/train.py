"""One bounded serverless SFT attempt with persistent, non-secret receipts."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env.local', override=False)
os.environ['PYTHON_DOTENV_DISABLED'] = '1'


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', action='store_true', help='Submit the one authorized training job after registration.')
    parser.add_argument('--name', default=f"flowblock-sft-v1-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}")
    parser.add_argument('--timeout-seconds', type=int, default=900)
    parser.add_argument('--resume-registration', help='Receipt of a registered attempt proven not to have submitted a training job.')
    args = parser.parse_args()
    if not os.environ.get('WANDB_API_KEY') or not os.environ.get('WANDB_ENTITY'):
        raise SystemExit('WANDB_API_KEY and WANDB_ENTITY are required.')
    frozen = ROOT / 'training' / 'frozen'
    manifest = json.loads((frozen / 'manifest.json').read_text())
    dataset = frozen / 'train.jsonl'
    if sha256(dataset) != manifest['files']['train.jsonl']:
        raise SystemExit('Training data differs from the frozen manifest.')
    rows = [json.loads(line) for line in dataset.read_text().splitlines()]
    if not 1 <= len(rows) <= 400:
        raise SystemExit('The approved run must contain 1 through 400 examples.')
    if any(row['messages'][-1]['role'] != 'assistant' for row in rows):
        raise SystemExit('Every SFT row must end in an assistant action.')
    artifact_dir = ROOT / 'training' / 'artifacts'
    artifact_dir.mkdir(parents=True, exist_ok=True)
    previous = None
    if args.resume_registration:
        previous = json.loads(Path(args.resume_registration).read_text())
        if previous.get('trainingSubmitted') or not previous.get('modelId'):
            raise SystemExit('Only a registered attempt with no submitted training job may resume this way.')
        args.name = previous['attempt']
    receipt_path = artifact_dir / (f'{args.name}-resume-{datetime.now(timezone.utc).strftime("%H%M%S")}.json' if previous else f'{args.name}.json')
    if receipt_path.exists():
        raise SystemExit('Attempt receipt already exists. Inspect its status; uncertain writes must not be retried automatically.')
    receipt = {
        'attempt': args.name, 'status': 'preflight', 'startedAt': now(),
        'datasetSha256': sha256(dataset), 'manifestSha256': sha256(frozen / 'manifest.json'),
        'baseModel': 'meta-llama/Llama-3.1-8B-Instruct',
        'trainingBaseUrl': os.environ.get('WANDB_TRAINING_BASE_URL', 'https://forge.coreweave.com/api/training/v1'),
        'rows': len(rows), 'epochs': 1, 'batchSize': 8, 'peakLearningRate': 2e-4,
        'assistantTurns': 'last', 'artVersion': importlib.metadata.version('openpipe-art'),
        'budget': 'One run, at most 400 frozen examples, one epoch. No retries of POSTs.',
        'registrationSubmitted': False, 'trainingSubmitted': False,
        'resumesRegistrationReceipt': args.resume_registration,
    }

    def save() -> None:
        receipt['updatedAt'] = now()
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')

    save()
    import art
    from art.serverless.backend import ServerlessBackend
    from art.utils.sft import train_sft_from_file

    backend = ServerlessBackend(base_url=receipt['trainingBaseUrl'])
    # The SDK disables POST retries. Use a bounded transport timeout as well.
    backend._client.timeout = 45.0
    model = art.TrainableModel(
        name=args.name, run_name=args.name, entity=os.environ['WANDB_ENTITY'],
        project=os.environ.get('WANDB_PROJECT', 'flowblock'), base_model=receipt['baseModel'],
    )
    try:
        receipt['registrationSubmitted'] = True
        save()
        await asyncio.wait_for(model.register(backend), timeout=60)
        receipt.update(status='registered', modelId=model.id, runId=model.run_id,
                       inferenceBaseUrl=model.inference_base_url,
                       runUrl=f"https://forge.coreweave.com/wandb/{model.entity}/{model.project}/runs/{model.run_id}")
        save()
        if not args.train:
            print(json.dumps({'status': receipt['status'], 'receipt': str(receipt_path)}))
            return

        create_job = backend._client.sft_training_jobs.create

        async def record_job(**kwargs):
            receipt.update(status='submitting-training', trainingSubmitted=True,
                           trainingDataArtifact=kwargs.get('training_data_url'))
            save()
            result = await create_job(**kwargs)
            receipt.update(status='training', trainingJobId=result.id)
            save()
            return result

        backend._client.sft_training_jobs.create = record_job
        await asyncio.wait_for(train_sft_from_file(
            model=model, file_path=str(dataset), epochs=1, batch_size=8,
            peak_lr=2e-4, schedule_type='cosine', assistant_turns='last', verbose=True,
        ), timeout=args.timeout_seconds)
        step = await model.get_step()
        if step <= 0:
            raise RuntimeError('Training returned without a positive checkpoint step.')
        receipt.update(status='trained', trainedStep=step,
                       inferenceModel=model.get_inference_name(step=step), completedAt=now())
        save()
        # A stable pointer only exists after positive checkpoint readback.
        (artifact_dir / 'training-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'status': 'trained', 'step': step, 'receipt': str(receipt_path)}))
    except Exception as error:
        detail = str(error).replace(os.environ['WANDB_API_KEY'], '[redacted]')
        status = getattr(error, 'status_code', None)
        receipt.update(status='submitted-outcome-unknown' if receipt['trainingSubmitted'] and status is None else 'failed',
                       errorType=type(error).__name__, httpStatus=status, error=detail[:4000])
        save()
        print(json.dumps({'status': receipt['status'], 'httpStatus': status, 'error': detail[:1000], 'receipt': str(receipt_path)}))
    finally:
        await backend.close()
        if model._wandb_run is not None:
            model._wandb_run.finish(exit_code=0 if receipt['status'] == 'trained' else 1)


if __name__ == '__main__':
    asyncio.run(main())
