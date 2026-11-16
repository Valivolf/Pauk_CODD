import { loadBotConfig } from './config.ts';

export class ApiError extends Error {
  statusCode: number;
  detail: string;

  constructor(statusCode: number, detail: string) {
    super(`${statusCode}: ${detail}`);
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export class NotFoundError extends ApiError {}

export class BotApiClient {
  private baseUrl: string;
  private botKey: string;

  constructor(baseUrl?: string, botKey?: string) {
    const cfg = loadBotConfig();
    this.baseUrl = (baseUrl || cfg.lanCalendarApiUrl).replace(/\/+$/, '');
    this.botKey = botKey ?? cfg.botApiKey;
  }

  configure(baseUrl: string, botKey: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.botKey = botKey;
  }

  private q(val: string): string {
    return encodeURIComponent(val);
  }

  private buildUrl(endpoint: string, params?: Record<string, string | number | boolean | undefined | null>): string {
    const url = new URL(endpoint.startsWith('/') ? endpoint : `/${endpoint}`, `${this.baseUrl}/`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private async request<T = unknown>(
    method: string,
    endpoint: string,
    opts: {
      params?: Record<string, string | number | boolean | undefined | null>;
      json?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      'X-Bot-Key': this.botKey,
    };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const resp = await fetch(this.buildUrl(endpoint, opts.params), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (resp.status === 404) {
      let detail = 'Не найдено';
      try {
        const j = (await resp.json()) as { detail?: string };
        detail = j.detail || detail;
      } catch {
        // ignore
      }
      throw new NotFoundError(404, detail);
    }
    if (resp.status >= 400) {
      let detail = '';
      try {
        const j = (await resp.json()) as { detail?: string };
        detail = String(j.detail || '');
      } catch {
        detail = await resp.text().catch(() => '');
      }
      throw new ApiError(resp.status, detail || `HTTP ${resp.status}`);
    }
    const text = await resp.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  async getBotEnabled(): Promise<boolean> {
    const r = await this.request<{ enabled?: boolean }>('GET', '/api/bot/enabled');
    return Boolean(r.enabled ?? true);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getMe(vkId: number): Promise<any | null> {
    try {
      return await this.request('GET', '/api/bot/me', { params: { vk_id: vkId } });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listTasks(vkId: number, day: string): Promise<any[]> {
    return this.request('GET', '/api/bot/tasks', { params: { vk_id: vkId, day } });
  }

  async acceptAuxTask(taskId: string, vkId: number) {
    return this.request('POST', '/api/bot/aux-accept', { json: { task_id: taskId, vk_id: vkId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async startWorkSession(taskId: string, vkId: number): Promise<any> {
    return this.request('POST', '/api/bot/work-sessions', { json: { task_id: taskId, vk_id: vkId } });
  }

  async endWorkSession(sessionId: number) {
    return this.request('PUT', `/api/bot/work-sessions/${sessionId}/end`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getPoint(pointId: string): Promise<any> {
    return this.request('GET', `/api/bot/points/${this.q(pointId)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setPointSim(pointId: string, simNumber: string): Promise<any> {
    return this.request('POST', `/api/bot/points/${this.q(pointId)}/sim`, { json: { sim_number: simNumber } });
  }

  async setPointPowerSource(pointId: string, powerSource: string) {
    return this.request('POST', `/api/bot/points/${this.q(pointId)}/power-source`, {
      json: { power_source: powerSource },
    });
  }

  async recheckPoint(pointId: string): Promise<{ status: string }> {
    return this.request('POST', `/api/bot/points/${this.q(pointId)}/recheck`, { timeoutMs: 35_000 });
  }

  async submitVisitReport(params: {
    taskId: string;
    vkId: number;
    resultStatus: string;
    comment?: string;
    equipmentRemoved?: string | null;
    equipmentInstalled?: string | null;
    repairMode?: boolean;
    fault?: string | null;
    needs?: string | null;
    outcome?: string | null;
    simRemoved?: string | null;
    simInstalled?: string | null;
    simRemovedState?: string | null;
  }) {
    return this.request('POST', '/api/bot/visit-reports', {
      json: {
        task_id: params.taskId,
        vk_id: params.vkId,
        result_status: params.resultStatus,
        comment: params.comment || '',
        equipment_removed: params.equipmentRemoved ?? null,
        equipment_installed: params.equipmentInstalled ?? null,
        repair_mode: Boolean(params.repairMode),
        fault: params.fault ?? null,
        needs: params.needs ?? null,
        outcome: params.outcome ?? null,
        sim_removed: params.simRemoved ?? null,
        sim_installed: params.simInstalled ?? null,
        sim_removed_state: params.simRemovedState ?? null,
      },
    });
  }

  async uploadPhoto(vkId: number, taskId: string, filename: string, content: Buffer): Promise<{ id: number; duplicate?: boolean }> {
    const form = new FormData();
    form.append('vk_id', String(vkId));
    form.append('task_id', taskId);
    form.append('file', new Blob([new Uint8Array(content)], { type: 'image/jpeg' }), filename);
    const resp = await fetch(this.buildUrl('/api/bot/photos'), {
      method: 'POST',
      headers: { 'X-Bot-Key': this.botKey },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (resp.status >= 400) {
      let detail = '';
      try {
        const j = (await resp.json()) as { detail?: string };
        detail = String(j.detail || '');
      } catch {
        detail = await resp.text().catch(() => '');
      }
      throw new ApiError(resp.status, detail || `HTTP ${resp.status}`);
    }
    return (await resp.json()) as { id: number; duplicate?: boolean };
  }

  async listMyPhotos(vkId: number, taskId: string): Promise<Array<{ id: number; uploaded_at: string }>> {
    return this.request('GET', '/api/bot/photos', { params: { vk_id: vkId, task_id: taskId } });
  }

  async deletePhoto(photoId: number, vkId: number, taskId: string): Promise<void> {
    await this.request('DELETE', `/api/bot/photos/${photoId}`, { params: { vk_id: vkId, task_id: taskId } });
  }

  async submitJoinRequest(vkId: number, vkName: string | null): Promise<{ status: string; cooldown_active?: boolean }> {
    return this.request('POST', '/api/bot/join-requests', { json: { vk_id: vkId, vk_name: vkName } });
  }

  async getDispatcherPhones(): Promise<Array<{ full_name: string; phone: string }>> {
    return this.request('GET', '/api/bot/dispatcher-phones');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createAccessIssueRequest(taskId: string): Promise<any> {
    return this.request('POST', '/api/bot/access-issues', { json: { task_id: taskId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAccessIssueRequest(requestId: number): Promise<any> {
    return this.request('GET', `/api/bot/access-issues/${requestId}`);
  }

  async setPointPowerStatus(pointId: string, statusVal: string): Promise<void> {
    await this.request('POST', `/api/bot/points/${this.q(pointId)}/power-status`, { json: { status: statusVal } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createDemontageRequest(taskId: string, reason: string, kind = 'demontage'): Promise<any> {
    return this.request('POST', '/api/bot/demontage-requests', { json: { task_id: taskId, reason, kind } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getDemontageRequest(requestId: number): Promise<any> {
    return this.request('GET', `/api/bot/demontage-requests/${requestId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async watchTask(taskId: string, workSessionId: number, vkId?: number): Promise<any> {
    return this.request('GET', `/api/bot/tasks/${taskId}/watch`, {
      params: { work_session_id: workSessionId, vk_id: vkId },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTaskProgress(taskId: string, vkId: number): Promise<any> {
    return this.request('GET', `/api/bot/tasks/${taskId}/progress`, { params: { vk_id: vkId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async patchTaskProgress(taskId: string, vkId: number, patch: Record<string, unknown>): Promise<any> {
    return this.request('PUT', `/api/bot/tasks/${taskId}/progress`, { json: { vk_id: vkId, patch } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getActiveSession(vkId: number): Promise<{ session: any | null }> {
    return this.request('GET', '/api/bot/active-session', { params: { vk_id: vkId } });
  }

  // ---- Equipment ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getPointEquipment(pointId: string): Promise<any> {
    return this.request('GET', `/api/bot/equipment/point/${this.q(pointId)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHeldEquipment(vkId: number, categoryId?: number): Promise<any[]> {
    return this.request('GET', '/api/bot/equipment/held', { params: { vk_id: vkId, category_id: categoryId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findEquipment(vkId: number, q: string): Promise<any[]> {
    return this.request('GET', '/api/bot/equipment/find', { params: { vk_id: vkId, q } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findEquipmentBySuffix(vkId: number, suffix: string, categoryId?: number): Promise<any[]> {
    return this.request('GET', '/api/bot/equipment/by-suffix', {
      params: { vk_id: vkId, suffix, category_id: categoryId },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async installEquipmentBySuffix(params: {
    vkId: number;
    pointId: string;
    suffix: string;
    oldId?: number | null;
    newId?: number | null;
    categoryId?: number | null;
    reason?: string | null;
  }): Promise<any> {
    return this.request('POST', '/api/bot/equipment/install-by-suffix', {
      json: {
        vk_id: params.vkId,
        point_id: params.pointId,
        suffix: params.suffix,
        old_equipment_id: params.oldId ?? null,
        new_equipment_id: params.newId ?? null,
        category_id: params.categoryId ?? null,
        reason: params.reason ?? null,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async replaceEquipment(
    vkId: number,
    pointId: string,
    oldId: number,
    newId: number,
    actual: Record<string, unknown> = {},
    reason?: string | null,
  ): Promise<any> {
    return this.request('POST', '/api/bot/equipment/replace', {
      json: { vk_id: vkId, point_id: pointId, old_equipment_id: oldId, new_equipment_id: newId, reason: reason ?? null, ...actual },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async installEquipment(vkId: number, pointId: string, equipmentId: number): Promise<any> {
    return this.request('POST', '/api/bot/equipment/install', {
      json: { vk_id: vkId, point_id: pointId, equipment_id: equipmentId },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async removeEquipment(
    vkId: number,
    pointId: string,
    equipmentId: number,
    actual: Record<string, unknown> = {},
    reason?: string | null,
  ): Promise<any> {
    return this.request('POST', '/api/bot/equipment/remove', {
      json: { vk_id: vkId, point_id: pointId, equipment_id: equipmentId, reason: reason ?? null, ...actual },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async simReplace(
    vkId: number,
    pointId: string,
    serialNumber: string,
    reason?: string | null,
    removedWorking?: boolean | null,
  ): Promise<any> {
    return this.request('POST', '/api/bot/equipment/sim/replace', {
      json: {
        vk_id: vkId,
        point_id: pointId,
        serial_number: serialNumber,
        reason: reason ?? null,
        removed_working: removedWorking ?? null,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async simFix(vkId: number, pointId: string, serialNumber: string): Promise<any> {
    return this.request('POST', '/api/bot/equipment/sim/fix', {
      json: { vk_id: vkId, point_id: pointId, serial_number: serialNumber },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async demontageEquipment(
    vkId: number,
    pointId: string,
    whole: boolean,
    equipmentIds: number[] = [],
    reason?: string | null,
  ): Promise<any> {
    return this.request('POST', '/api/bot/equipment/demontage', {
      json: { vk_id: vkId, point_id: pointId, whole, equipment_ids: equipmentIds, reason: reason ?? null },
    });
  }

  // ---- Warehouse ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whSummary(vkId: number): Promise<any> {
    return this.request('GET', '/api/bot/warehouse/summary', { params: { vk_id: vkId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whAwaiting(vkId: number): Promise<any[]> {
    return this.request('GET', '/api/bot/warehouse/awaiting', { params: { vk_id: vkId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whPersonItems(vkId: number, personId: number): Promise<any[]> {
    return this.request('GET', `/api/bot/warehouse/person/${personId}/items`, { params: { vk_id: vkId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whAccept(vkId: number, equipmentIds: number[], personId?: number | null): Promise<any> {
    return this.request('POST', '/api/bot/warehouse/accept', {
      json: { vk_id: vkId, equipment_ids: equipmentIds, person_id: personId ?? null },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whAcceptSubstitute(
    vkId: number,
    expectedId: number,
    personId: number | null | undefined,
    actual: Record<string, unknown>,
  ): Promise<any> {
    return this.request('POST', '/api/bot/warehouse/accept-substitute', {
      json: { vk_id: vkId, expected_id: expectedId, person_id: personId ?? null, ...actual },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whFound(vkId: number, equipmentId: number): Promise<any> {
    return this.request('POST', '/api/bot/warehouse/found', { json: { vk_id: vkId, equipment_id: equipmentId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whFitters(vkId: number, q = ''): Promise<any[]> {
    return this.request('GET', '/api/bot/warehouse/fitters', { params: { vk_id: vkId, q } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whCategories(vkId: number): Promise<any[]> {
    return this.request('GET', '/api/bot/warehouse/categories', { params: { vk_id: vkId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whStock(vkId: number, categoryId?: number | null, q = '', limit = 100): Promise<any> {
    return this.request('GET', '/api/bot/warehouse/stock', {
      params: { vk_id: vkId, category_id: categoryId ?? undefined, q, limit },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whIssue(vkId: number, personId: number, equipmentIds: number[], serials: string[]): Promise<any> {
    return this.request('POST', '/api/bot/warehouse/issue', {
      json: { vk_id: vkId, person_id: personId, equipment_ids: equipmentIds, serials },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whFind(vkId: number, q: string): Promise<any[]> {
    return this.request('GET', '/api/bot/warehouse/find', { params: { vk_id: vkId, q } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whStatuses(vkId: number): Promise<any[]> {
    return this.request('GET', '/api/bot/warehouse/statuses', { params: { vk_id: vkId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async whSetStatus(vkId: number, equipmentId: number, statusId: number, comment?: string | null): Promise<any> {
    return this.request('POST', '/api/bot/warehouse/set-status', {
      json: { vk_id: vkId, equipment_id: equipmentId, status_id: statusId, comment: comment ?? null },
    });
  }

  // ---- Chat & AI ----
  async chatSend(vkId: number, text: string, taskId?: string | null, pointId?: string | null) {
    return this.request('POST', '/api/bot/chat/send', {
      json: { vk_id: vkId, text, task_id: taskId ?? null, point_id: pointId ?? null },
    });
  }

  async aiConfig(): Promise<{ bot_voice?: boolean; asr_ready?: boolean; llm_ready?: boolean }> {
    return this.request('GET', '/api/bot/ai/config');
  }

  async aiVoice(
    vkId: number,
    taskId: string,
    pointId: string,
    visitType: string,
    filename: string,
    content: Buffer,
  ): Promise<{ job_id: string }> {
    const form = new FormData();
    form.append('vk_id', String(vkId));
    form.append('task_id', taskId || '');
    form.append('point_id', pointId || '');
    form.append('visit_type', visitType || '');
    form.append('file', new Blob([new Uint8Array(content)], { type: 'audio/ogg' }), filename);
    const resp = await fetch(this.buildUrl('/api/bot/ai/voice'), {
      method: 'POST',
      headers: { 'X-Bot-Key': this.botKey },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.status >= 400) {
      let detail = '';
      try {
        const j = (await resp.json()) as { detail?: string };
        detail = String(j.detail || '');
      } catch {
        detail = await resp.text().catch(() => '');
      }
      throw new ApiError(resp.status, detail || `HTTP ${resp.status}`);
    }
    return (await resp.json()) as { job_id: string };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async aiVoiceJob(jobId: string, vkId: number): Promise<any> {
    return this.request('GET', `/api/bot/ai/jobs/${jobId}`, { params: { vk_id: vkId } });
  }

  async chatSendPhotos(
    vkId: number,
    text: string,
    files: Array<{ name: string; content: Buffer }>,
    taskId?: string | null,
    pointId?: string | null,
  ): Promise<{ id: number; photos: number }> {
    const form = new FormData();
    form.append('vk_id', String(vkId));
    form.append('text', text);
    if (taskId) form.append('task_id', taskId);
    if (pointId) form.append('point_id', pointId);
    for (const f of files) {
      form.append('files', new Blob([new Uint8Array(f.content)], { type: 'image/jpeg' }), f.name);
    }
    const resp = await fetch(this.buildUrl('/api/bot/chat/send-photos'), {
      method: 'POST',
      headers: { 'X-Bot-Key': this.botKey },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.status >= 400) {
      let detail = '';
      try {
        const j = (await resp.json()) as { detail?: string };
        detail = String(j.detail || '');
      } catch {
        detail = await resp.text().catch(() => '');
      }
      throw new ApiError(resp.status, detail || `HTTP ${resp.status}`);
    }
    return (await resp.json()) as { id: number; photos: number };
  }

  async chatFile(attId: number): Promise<Buffer> {
    const resp = await fetch(this.buildUrl(`/api/bot/chat/files/${attId}`), {
      headers: { 'X-Bot-Key': this.botKey },
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.status >= 400) throw new ApiError(resp.status, 'фото недоступно');
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async chatClaim(): Promise<any[]> {
    return this.request('POST', '/api/bot/chat/claim');
  }

  async chatDelivered(ids: number[]): Promise<void> {
    if (ids.length) await this.request('POST', '/api/bot/chat/delivered', { json: { ids } });
  }

  async chatFailed(messageId: number, error: string): Promise<void> {
    await this.request('POST', '/api/bot/chat/failed', { json: { id: messageId, error } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createVerificationRequest(taskId: string): Promise<any> {
    return this.request('POST', '/api/bot/verification-requests', { json: { task_id: taskId } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getVerificationRequest(requestId: number): Promise<any> {
    return this.request('GET', `/api/bot/verification-requests/${requestId}`);
  }
}

export const apiClient = new BotApiClient();
