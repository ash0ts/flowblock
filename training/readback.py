"""Read existing training events/checkpoints without starting or retrying a job."""
import argparse
import asyncio
import json
import os
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from art.serverless.client import Client

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env.local', override=False)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('receipt')
    args = parser.parse_args()
    receipt = json.loads(Path(args.receipt).read_text())
    client = Client(base_url=receipt['trainingBaseUrl'])
    client.timeout = 30.0
    try:
        events = [event.model_dump() async for event in client.sft_training_jobs.events.list(training_job_id=receipt['trainingJobId'])]
        checkpoints = [checkpoint.model_dump() async for checkpoint in client.models.checkpoints.list(model_id=receipt['modelId'], order='desc', limit=10)]
        gradients = [event for event in events if event['type'] == 'gradient_step']
        result = {
            'readAt': datetime.now(timezone.utc).isoformat(), 'trainingJobId': receipt['trainingJobId'],
            'modelId': receipt['modelId'], 'events': events, 'checkpoints': checkpoints,
            'gradientUpdates': len(gradients), 'firstLoss': gradients[0]['data'].get('loss') if gradients else None,
            'lastLoss': gradients[-1]['data'].get('loss') if gradients else None,
            'totalReportedTokens': sum(event['data'].get('num_tokens', 0) for event in gradients),
            'totalLossBearingTokens': sum(event['data'].get('num_trainable_tokens', 0) for event in gradients),
            'completed': any(event['type'] == 'training_ended' for event in events),
            'canonicalRunUrl': f"https://forge.coreweave.com/wandb/{os.environ['WANDB_ENTITY']}/{os.environ.get('WANDB_PROJECT', 'flowblock')}/runs/{receipt['runId']}",
        }
        directory = ROOT / 'training' / 'results'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'training-readback.json').write_text(json.dumps(result, indent=2) + '\n')
        positive = [checkpoint for checkpoint in checkpoints if checkpoint['step'] > 0]
        if result['completed'] and positive:
            checkpoint = positive[0]
            recovered = {
                **receipt, 'status': 'trained', 'trainedStep': checkpoint['step'],
                'inferenceModel': f"wandb-artifact:///{os.environ['WANDB_ENTITY']}/{os.environ.get('WANDB_PROJECT', 'flowblock')}/{receipt['attempt']}:step{checkpoint['step']}",
                'runUrl': result['canonicalRunUrl'], 'recoveredFromReadback': True,
                'originalReceiptStatus': receipt['status'], 'verifiedAt': result['readAt'],
                'readbackSha256': hashlib.sha256((directory / 'training-readback.json').read_bytes()).hexdigest(),
            }
            (ROOT / 'training' / 'artifacts' / 'training-receipt.json').write_text(json.dumps(recovered, indent=2) + '\n')
            (directory / 'training-receipt.json').write_text(json.dumps(recovered, indent=2) + '\n')
        print(json.dumps({key: value for key, value in result.items() if key not in ['events', 'checkpoints']} | {'checkpoints': checkpoints}))
    finally:
        await client.close()


asyncio.run(main())
