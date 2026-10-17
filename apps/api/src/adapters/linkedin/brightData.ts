import { setTimeout } from 'node:timers/promises';

import { z } from 'zod';
import uniq from 'lodash/uniq';

import { parseJsonResponse } from '../../lib/utils/fetch';
import { LinkedinAdapter, ProfileFetchBudget } from './interface';
import { MINUTE, SECOND } from '../../constants';
import { logger } from 'movement-engine/public/log';
import { safeToUrl } from '../../lib/utils/url';
import { neverAsAny } from 'movement-engine/public/types';
import { notNull, notUndefined } from '../../lib/utils/nullability';
import { sendSlackNotification } from '../../lib/slack';
import { Queue } from 'movement-engine/public/queue';

// BrightData long-polls (up to 5min per request) — limit concurrent requests
const brightDataQueue = new Queue<unknown>({ concurrency: 4 });

const triggerCollectionBody = z.array(z.object({ url: z.string() }));
type TriggerCollectionBody = z.infer<typeof triggerCollectionBody>;
const triggerCollectionResponse = z.union([
  z.object({ snapshot_id: z.string() }),
  z.object({ error: z.string() }),
]);
type TriggerCollectionResponse = z.infer<typeof triggerCollectionResponse>;

const monitorProgressResponse = z.object({
  status: z.enum(['starting', 'running', 'collecting', 'digesting', 'ready', 'failed']),
  snapshot_id: z.string(),
  dataset_id: z.string(),
  records: z.number().nullish(),
  errors: z.number().nullish(),
  error_codes: z.record(z.string(), z.number()).nullish(),
});
type MonitorProgressResponse = z.infer<typeof monitorProgressResponse>;

const deliveryResponse = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullish(),
    city: z.string().nullish(),
    country_code: z.string().nullish(),
    position: z.string().nullish(),
    avatar: z.string().nullish(),
    current_company: z
      .object({
        name: z.string().nullish(),
        company_id: z.string().nullish(),
        title: z.string().nullish(),
        location: z.string().nullish(),
      })
      .nullish(),
    experience: z
      .array(
        z.object({
          title: z.string().nullish(),
          location: z.string().nullish(),
          description_html: z.string().nullish(),
          start_date: z.string().nullish(),
          end_date: z.string().nullish(),
          company: z.string().nullish(),
          company_id: z.string().nullish(),
          url: z.string().nullish(),
          company_logo_url: z.string().nullish(),
        }),
      )
      .nullish(),
    education: z
      .array(
        z.object({
          school: z.string().nullish(),
          degree: z.string().nullish(),
          field_of_study: z.string().nullish(),
          start_date: z.string().nullish(),
          end_date: z.string().nullish(),
        }),
      )
      .nullish(),
  }),
);
type DeliveryResponse = z.infer<typeof deliveryResponse>;

class BrightDataAdapter implements LinkedinAdapter {
  private accessToken: string;
  private monitorTimeoutMs = 5 * MINUTE;
  private monitorIntervalMs = 5 * SECOND;

  constructor({
    accessToken,
    monitorTimeoutMs,
  }: {
    accessToken: string;
    monitorTimeoutMs?: number;
  }) {
    this.accessToken = accessToken;
    this.monitorTimeoutMs = monitorTimeoutMs ?? this.monitorTimeoutMs;
  }

  async getProfileTextByUrl(
    url: string,
    budget?: ProfileFetchBudget,
  ): Promise<{ text?: string | null; avatar?: string | null } | null> {
    return brightDataQueue.enqueue(() => this.getProfileTextByUrlInner(url, budget)) as Promise<{ text?: string | null; avatar?: string | null } | null>;
  }

  private async getProfileTextByUrlInner(
    url: string,
    budget?: ProfileFetchBudget,
  ): Promise<{ text?: string | null; avatar?: string | null } | null> {
    // handle missing https etc
    const cleanUrl = safeToUrl(url)?.href;
    if (!cleanUrl) {
      logger.error(`Invalid linkedin url: ${url}`);
      return null;
    }

    const triggerResponse = await this.triggerCollection([{ url: cleanUrl }]);

    if ('error' in triggerResponse) {
      logger.error(`Bright Data error: ${JSON.stringify(triggerResponse)}`);
      return null;
    }

    const { snapshot_id } = triggerResponse;

    // A caller that named a budget has decided it would rather have nothing
    // than wait; without one, wait as long as this adapter always has.
    const budgetedWaitMs = budget?.maxWaitMs;
    const waitMs = budgetedWaitMs ?? this.monitorTimeoutMs;

    const startTime = new Date();
    let status: MonitorProgressResponse['status'] = 'collecting';
    while (status !== 'ready' && status !== 'failed' && this.isNotTimedOut(startTime, waitMs)) {
      await setTimeout(this.monitorIntervalMs);
      const progress = await this.monitorProgress(snapshot_id);
      status = progress.status;

      if (progress.errors) {
        logger.error(
          `Bright Data errors on ${cleanUrl}: ${progress.error_codes ? Object.keys(progress.error_codes).join(', ') : 'Unknown'}`,
        );
        return null;
      }
    }

    if (status !== 'ready' && status !== 'failed') {
      // Running out of a budget the caller chose is the budget working, not a
      // fault: collection is still in flight and the caller wanted the empty
      // answer sooner. Running out of this adapter's own patience is a fault.
      const message = `Bright Data had not finished collecting ${cleanUrl} after ${waitMs}ms`;
      if (budgetedWaitMs) logger.info(message);
      else logger.error(message);
      return null;
    } else if (status === 'failed') {
      logger.error(`Bright Data failed on ${cleanUrl}`);
      return null;
    } else if (status === 'ready') {
      const delivery = await this.delivery(snapshot_id);
      if (delivery.length !== 1) {
        logger.error(`Bright Data delivered ${delivery.length} items on ${cleanUrl}`);
        return null;
      }

      const person = delivery[0];
      const formattedPersonData = [
        person.name ? `Name: ${person.name}` : null,
        person.position ? `Position: ${person.position}` : null,
        person.current_company
          ? `Current company: ${[person.current_company.title, person.current_company.name].filter(notNull).filter(notUndefined).join(' @ ')}`
          : null,
        person.city ? `City: ${person.city}` : null,
        person.country_code ? `Country: ${person.country_code}` : null,
        person.experience?.length
          ? `Past experience:\n${person.experience
              .map((experience) => {
                const title = experience.title;
                const company = experience.company;
                const startDate = experience.start_date;
                const endDate = experience.end_date;
                if (!title && !company) {
                  return null;
                }

                const occupationLine = [title, company].filter(notNull).join(' @ ');
                const dateLine = uniq([startDate, endDate]).filter(notNull).join(' - ');
                return `  - ${occupationLine}${dateLine ? ` (${dateLine})` : ''}`;
              })
              .filter(notNull)
              .join('\n')}`
          : null,
        person.education?.length
          ? `Education:\n${person.education
              .map((education) => {
                const school = education.school;
                const degree = education.degree;
                const fieldOfStudy = education.field_of_study;
                const startDate = education.start_date;
                const endDate = education.end_date;
                if (!school && !degree && !fieldOfStudy) {
                  return null;
                }

                const degreeLine = degree
                  ? fieldOfStudy
                    ? `${degree} in ${fieldOfStudy}`
                    : degree
                  : fieldOfStudy
                    ? fieldOfStudy
                    : null;
                const schoolLine = [degreeLine, school].filter(notNull).join(' @ ');
                const dateLine = uniq([startDate, endDate]).filter(notNull).join(' - ');
                return `  - ${schoolLine}${dateLine ? ` (${dateLine})` : ''}`;
              })
              .filter(notNull)
              .join('\n')}`
          : null,
      ]
        .filter(notNull)
        .join('\n');

      return {
        text: formattedPersonData,
        avatar: person.avatar,
      };
    } else {
      throw new Error(`Unknown status: ${neverAsAny(status)}`);
    }
  }

  private isNotTimedOut(startTime: Date, waitMs: number) {
    return new Date().getTime() - startTime.getTime() < waitMs;
  }

  private async triggerCollection(body: TriggerCollectionBody): Promise<TriggerCollectionResponse> {
    return this.fetch({
      route: `/datasets/v3/trigger?dataset_id=gd_l1viktl72bvl7bjuj0&include_errors=true`,
      method: 'POST',
      body,
      responseValidator: triggerCollectionResponse,
    });
  }

  private async monitorProgress(snapshotId: string): Promise<MonitorProgressResponse> {
    const json = await this.fetch<unknown>({
      route: `/datasets/v3/progress/${snapshotId}`,
      method: 'GET',
    });
    const result = monitorProgressResponse.safeParse(json);
    if (!result.success) {
      const rawStatus = (json as Record<string, unknown>)?.status;
      logger.error(`BrightData unknown progress status`, { snapshotId, rawStatus, json });
      await sendSlackNotification({
        type: 'SUPPORT',
        text: `Bright Data API returned unknown progress status: "${rawStatus}" (snapshot ${snapshotId}). The status enum in brightData.ts needs updating.`,
        opsTitle: `Bright Data returned an unknown progress status "${rawStatus}"`,
      });
      throw result.error;
    }
    return result.data;
  }

  private async delivery(snapshotId: string): Promise<DeliveryResponse> {
    return this.fetch({
      route: `/datasets/v3/snapshot/${snapshotId}`,
      query: { format: 'json' },
      method: 'GET',
      responseValidator: deliveryResponse,
    });
  }

  private async fetch<T = unknown, U = unknown>({
    route,
    method,
    body,
    formData,
    query,
    responseValidator,
  }: {
    route: string;
    method: string;
    body?: U;
    formData?: FormData;
    query?: Record<string, string>;
    responseValidator?: z.ZodType<T>;
    payloadValidator?: z.ZodType<U>;
  }): Promise<T> {
    const url = new URL(route, 'https://api.brightdata.com');
    if (query) {
      Object.entries(query).forEach(([key, value]) => url.searchParams.append(key, value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    } else if (formData) {
      headers['Content-Type'] = 'multipart/form-data';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : formData,
    });

    if (!response.ok) {
      let text;
      try {
        text = await response.text();
      } catch {
        // ignore
      }
      throw new Error(`BrightData Error: ${response.status} (${response.statusText}): ${text?.slice(0, 200)}`);
    }

    const json = await parseJsonResponse(response, 'BrightData');
    if (responseValidator) {
      const result = responseValidator.safeParse(json);
      if (!result.success) {
        logger.error(`BrightData ${route} response validation failed`, {
          response: JSON.stringify(json).slice(0, 500),
          errors: result.error.issues,
        });
        throw result.error;
      }
      return result.data;
    }
    return json as T;
  }
}

export { BrightDataAdapter };
