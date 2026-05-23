const { Client } = require('@notionhq/client');

let notion;
let DATABASE_ID;

function init() {
  notion = new Client({ auth: process.env.NOTION_TOKEN });
  DATABASE_ID = process.env.NOTION_DATABASE_ID;
}

// Fetch all pages from the Notion task database
async function getAllPages() {
  const pages = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return pages;
}

// Create a new page in the Notion database
async function createPage(properties) {
  const response = await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties,
  });
  return response;
}

// Update an existing Notion page
async function updatePage(pageId, properties) {
  const response = await notion.pages.update({
    page_id: pageId,
    properties,
  });
  return response;
}

// Archive (soft-delete) a Notion page
async function deletePage(pageId) {
  await notion.pages.update({
    page_id: pageId,
    archived: true,
  });
}

// Get Todoist ID stored in a Notion page property
function getTodoistIdFromPage(page) {
  return page.properties['Todoist ID']?.rich_text?.[0]?.plain_text || null;
}

// Store the Todoist task ID inside the Notion page
async function setTodoistId(pageId, todoistId) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      'Todoist ID': {
        rich_text: [{ text: { content: String(todoistId) } }],
      },
    },
  });
}

module.exports = {
  init,
  getAllPages,
  createPage,
  updatePage,
  deletePage,
  getTodoistIdFromPage,
  setTodoistId,
};
