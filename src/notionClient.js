import { requestJson } from './http.js';

const BASE_URL = 'https://api.notion.com/v1';
// Same API version the previous @notionhq/client v2 setup used.
const NOTION_VERSION = '2022-06-28';

export function createNotionClient({ token, databaseId, budget }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };

  const call = (method, path, body) =>
    requestJson(
      budget,
      `${BASE_URL}${path}`,
      { method, headers, body: body ? JSON.stringify(body) : undefined },
      'Notion',
    );

  return {
    // Fetch all pages from the Notion task database
    async getAllPages() {
      const pages = [];
      let cursor;
      do {
        const response = await call('POST', `/databases/${databaseId}/query`, {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        pages.push(...response.results);
        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor);
      return pages;
    },

    // Create a new page in the Notion database
    createPage(properties) {
      return call('POST', '/pages', {
        parent: { database_id: databaseId },
        properties,
      });
    },

    // Update an existing Notion page
    updatePage(pageId, properties) {
      return call('PATCH', `/pages/${pageId}`, { properties });
    },

    // Archive (soft-delete) a Notion page
    async deletePage(pageId) {
      await call('PATCH', `/pages/${pageId}`, { archived: true });
    },

    // Store the Todoist task ID inside the Notion page
    async setTodoistId(pageId, todoistId) {
      await call('PATCH', `/pages/${pageId}`, {
        properties: todoistIdProperty(todoistId),
      });
    },
  };
}

export function todoistIdProperty(todoistId) {
  return {
    'Todoist ID': { rich_text: [{ text: { content: String(todoistId) } }] },
  };
}
