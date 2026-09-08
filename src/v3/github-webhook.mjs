import crypto from 'node:crypto';

function clip(value, limit) {
  return String(value ?? '').slice(0, limit);
}

export function verifyGitHubSignature(secret, rawBody, signature) {
  const actual = String(signature ?? '').toLowerCase();
  if (!secret || (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string')) return false;
  if (!/^sha256=[0-9a-f]{64}$/.test(actual)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function projectForRepository(config, repository) {
  return config.projects.find((project) => {
    return project.enabled !== false && project.github?.repository === repository;
  }) ?? null;
}

function labelsOf(issue) {
  return new Set((issue?.labels ?? []).map((label) => {
    return typeof label === 'string' ? label : label?.name;
  }).filter(Boolean));
}

function validDeliveryId(value) {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(String(value ?? ''));
}

export function translateGitHubEvent(config, eventName, deliveryId, payload) {
  if (!validDeliveryId(deliveryId)) return { ignored: true, reason: 'invalid_delivery_id' };
  if (eventName !== 'issues') return { ignored: true, reason: 'unsupported_event' };
  if (!['opened', 'reopened', 'labeled'].includes(payload?.action)) {
    return { ignored: true, reason: 'unsupported_issue_action' };
  }
  const repository = clip(payload?.repository?.full_name, 200);
  const project = projectForRepository(config, repository);
  if (!project) return { ignored: true, reason: 'repository_not_configured' };

  const labels = labelsOf(payload.issue);
  const taskLabels = project.github?.taskLabels ?? [];
  if (payload.action === 'labeled') {
    const appliedLabel = typeof payload.label === 'string' ? payload.label : payload.label?.name;
    if (!taskLabels.includes(appliedLabel)) {
      return { ignored: true, reason: 'task_label_not_applied' };
    }
  } else if (!taskLabels.some((label) => labels.has(label))) {
    return { ignored: true, reason: 'task_label_missing' };
  }

  const issueNumber = Number(payload.issue?.number ?? 0);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return { ignored: true, reason: 'invalid_issue' };
  }

  return {
    ignored: false,
    event: {
      id: `github:${deliveryId}`,
      projectId: project.id,
      kind: 'task.received',
      task: {
        id: `github:${repository}#${issueNumber}`,
        source: 'github',
        repository,
        issueNumber,
        title: clip(payload.issue?.title, 300),
        url: clip(payload.issue?.html_url, 500),
      },
    },
  };
}
