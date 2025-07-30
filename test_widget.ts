#!/usr/bin/env node

/**
 * Синтетический тест для виджета Playgama
 * Тестирует клики по баннеру и собирает статистику
 */

import { chromium, Browser, Request } from 'playwright';
import * as fs from 'fs';

const WIDGET_SELECTOR = '#widget-playgama';
const ANALYTICS_URLS = ['analytics', 'playgama', 'google-analytics', 'gtag', 'collect'];
const CLICK_TIMEOUT = 2000;
const WIDGET_TIMEOUT = 10000;
const PAGE_TIMEOUT = 15000;
const TEST_DELAY = 3000;

type TestResults = {
  totalTests: number;
  successfulClicks: number;
  failedClicks: number;
  pageLoadErrors: number;
  widgetNotFound: number;
  testDuration: number;
  startTime: Date;
  endTime: Date;
  analyticsEvents: {
    success_load_content: number;
    error_load_content: number;
    widget_impression: number;
    click_widget: number;
    close_modal: number;
    game_impression: number;
    click_game: number;
  };
}

type ClickRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string | null;
}

type AnalyticsEvent = {
  eventName: string;
  sentAt: string;
  clid?: string;
  widgetId?: string;
  widget_domain?: string;
  widget_path?: string;
  game_id?: string;
  widget_have_powered_by_link?: boolean;
  eventPayload?: string;
}

type WidgetInfo = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
} | null;

class WidgetTester {
  private readonly _url: string;
  private readonly _numTests: number;
  private _results: TestResults;

  constructor(url: string, numTests: number = 100) {
    this._url = url;
    this._numTests = numTests;
    this._results = this._initializeResults();
  }

  private _initializeResults(): TestResults {
    return {
      totalTests: 0,
      successfulClicks: 0,
      failedClicks: 0,
      pageLoadErrors: 0,
      widgetNotFound: 0,
      testDuration: 0,
      startTime: new Date(),
      endTime: new Date(),
      analyticsEvents: {
        success_load_content: 0,
        error_load_content: 0,
        widget_impression: 0,
        click_widget: 0,
        close_modal: 0,
        game_impression: 0,
        click_game: 0,
      }
    };
  }

  private _isAnalyticsRequest(url: string, method: string): boolean {
    return method === 'POST' && ANALYTICS_URLS.some(analyticsUrl => url.includes(analyticsUrl));
  }

  private _parseAnalyticsData(postData: string | null, testNum: number): AnalyticsEvent | null {
    if (!postData) return null;
    
    try {
      const data = JSON.parse(postData);
      if (data.eventName) {
        return data as AnalyticsEvent;
      }
    } catch (e) {
      console.log(`Тест ${testNum}: Не удалось распарсить аналитические данные: ${postData.substring(0, 100)}...`);
    }
    return null;
  }

  private _trackAnalyticsEvent(eventName: string): void {
    if (eventName in this._results.analyticsEvents) {
      this._results.analyticsEvents[eventName as keyof typeof this._results.analyticsEvents]++;
    }
  }

  private async _getWidgetInfo(page: any): Promise<WidgetInfo> {
    return await page.evaluate((selector: string) => {
      const widget = document.querySelector(selector);
      if (!widget) return null;
      
      const rect = widget.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left
      };
    }, WIDGET_SELECTOR);
  }



  private async _checkIframeElements(page: any): Promise<boolean> {
    const iframeElements = await page.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      
      const iframeInfo = Array.from(iframes).map(el => ({
        tagName: el.tagName,
        className: el.className,
        id: el.id,
        src: (el as HTMLIFrameElement).src,
        visible: getComputedStyle(el).display !== 'none'
      }));
      
      return { iframes: iframeInfo };
    });
    
    return iframeElements.iframes.length > 0;
  }

  async runSingleTest(browser: Browser, testNum: number): Promise<boolean> {
    const page = await browser.newPage();
    
    try {
      const clickRequests: ClickRequest[] = [];
      const analyticsEvents: AnalyticsEvent[] = [];
      
      // Настройка отслеживания запросов
      page.on('request', (request: Request) => {
        const url = request.url();
        const method = request.method();
        const postData = request.postData();
        

        if (this._isAnalyticsRequest(url, method)) {
          console.log(`Тест ${testNum}: Аналитический запрос: ${method} ${url}`);
          
          const analyticsData = this._parseAnalyticsData(postData, testNum);
          if (analyticsData) {
            analyticsEvents.push(analyticsData);
            console.log(`Тест ${testNum}: Аналитическое событие: ${analyticsData.eventName}`);
            this._trackAnalyticsEvent(analyticsData.eventName);
          }
        }
        
        if (url.toLowerCase().includes('playgama') && method === 'POST') {
          clickRequests.push({
            url: url,
            method: method,
            headers: request.headers(),
            postData: postData
          });
        }
      });

      // Отслеживаем iframe
      page.on('frameattached', frame => {
        console.log(`Тест ${testNum}: Присоединен iframe: ${frame.url()}`);
      });

      console.log(`Тест ${testNum}: Загружаю страницу ${this._url}`);
      await page.goto(this._url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });
      
      try {
        await page.waitForSelector(WIDGET_SELECTOR, { timeout: WIDGET_TIMEOUT });
        console.log(`Тест ${testNum}: Виджет найден`);
        
        await page.waitForTimeout(1000);
        
        const widgetContent = await page.$eval(WIDGET_SELECTOR, el => el.innerHTML);
        console.log(`Тест ${testNum}: Контент виджета: ${widgetContent.substring(0, 100)}...`);
        
      } catch (error) {
        console.error(`Тест ${testNum}: Виджет не найден - ${error}`);
        this._results.widgetNotFound++;
        return false;
      }

      console.log(`Тест ${testNum}: Кликаем по координатам виджета...`);

      let successfulClicksInTest = 0;
      
      const widgetInfo = await this._getWidgetInfo(page);
      
      if (!widgetInfo) {
        console.log(`Тест ${testNum}: Виджет не найден`);
        return false;
      }

      console.log(`Тест ${testNum}: Виджет найден, размеры: ${widgetInfo.width}x${widgetInfo.height}, позиция: (${widgetInfo.x}, ${widgetInfo.y})`);
      
      await page.mouse.click(widgetInfo.x, widgetInfo.y);
      console.log(`Тест ${testNum}: Клик по центру виджета выполнен`);
      
      await page.waitForTimeout(CLICK_TIMEOUT);
      
      // Проверяем появление iframe после клика
      const hasIframe = await this._checkIframeElements(page);
      
      if (hasIframe) {
        console.log(`Тест ${testNum}: Найдены iframe после клика по центру`);
        successfulClicksInTest++;
      }
      
      await page.waitForTimeout(CLICK_TIMEOUT);

      if (successfulClicksInTest > 0) {
        console.log(`Тест ${testNum}: Успешных кликов: ${successfulClicksInTest}`);
        this._results.successfulClicks += successfulClicksInTest;
      } else {
        console.log(`Тест ${testNum}: Успешных кликов: 0`);
        this._results.failedClicks++;
      }
      
      // Выводим информацию об аналитических событиях
      console.log(`Тест ${testNum}: Аналитических событий: ${analyticsEvents.length}`);
      analyticsEvents.forEach(event => {
        console.log(`  - ${event.eventName}: ${JSON.stringify(event)}`);
      });
      
      return successfulClicksInTest > 0;
      
    } catch (error) {
      console.error(`Тест ${testNum}: Ошибка загрузки страницы - ${error}`);
      this._results.pageLoadErrors++;
      return false;
    } finally {
      await page.close();
    }
  }

  async runTests(): Promise<void> {
    this._results.startTime = new Date();
    
    // Вычисляем общее количество запланированных кликов
    const totalPlannedClicks = this._numTests;
    console.log(`Начинаю тестирование: ${this._numTests} тестов, ${totalPlannedClicks} запланированных кликов`);

    const browser = await chromium.launch({ 
      headless: false,
      slowMo: 1000
    });
    
    try {
      for (let i = 1; i <= this._numTests; i++) {
        this._results.totalTests++;
        await this.runSingleTest(browser, i);
        
        await new Promise(resolve => setTimeout(resolve, TEST_DELAY));
      }
    } finally {
      await browser.close();
    }
    
    this._results.endTime = new Date();
    this._results.testDuration = (this._results.endTime.getTime() - this._results.startTime.getTime()) / 1000;
    
    this._printResults();
    this.saveResults();
  }

  _printResults(): void {
    console.log('\n' + '='.repeat(50));
    console.log('РЕЗУЛЬТАТЫ СИНТЕТИЧЕСКОГО ТЕСТИРОВАНИЯ');
    console.log('='.repeat(50));
    console.log(`URL: ${this._url}`);
    console.log(`Всего тестов: ${this._results.totalTests}`);
    console.log(`Запланированных кликов: ${this._results.totalTests * 1}`);
    console.log(`Успешных кликов: ${this._results.successfulClicks}`);
    console.log(`Неудачных кликов: ${this._results.failedClicks}`);
    console.log(`Ошибок загрузки страницы: ${this._results.pageLoadErrors}`);
    console.log(`Виджет не найден: ${this._results.widgetNotFound}`);
    console.log(`Время выполнения: ${this._results.testDuration.toFixed(2)} секунд`);
    
    console.log('\nАНАЛИТИЧЕСКИЕ СОБЫТИЯ:');
    console.log(`success_load_content: ${this._results.analyticsEvents.success_load_content}`);
    console.log(`error_load_content: ${this._results.analyticsEvents.error_load_content}`);
    console.log(`widget_impression: ${this._results.analyticsEvents.widget_impression}`);
    console.log(`click_widget: ${this._results.analyticsEvents.click_widget}`);
    console.log(`close_modal: ${this._results.analyticsEvents.close_modal}`);
    console.log(`game_impression: ${this._results.analyticsEvents.game_impression}`);
    console.log(`click_game: ${this._results.analyticsEvents.click_game}`);
    
    if (this._results.totalTests > 0) {
      const successRate = (this._results.successfulClicks / this._results.totalTests) * 100;
      console.log(`Процент успешных кликов: ${successRate.toFixed(2)}%`);
    }
    
    console.log('='.repeat(10));
  }

  saveResults(): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsFile = `test_results_${timestamp}.json`;
    
    // Вычисляем процент успешных кликов
    const successRate = this._results.totalTests > 0 
      ? (this._results.successfulClicks / this._results.totalTests) * 100 
      : 0;
    
    const resultsForJson = {
      ...this._results,
      startTime: this._results.startTime.toISOString(),
      endTime: this._results.endTime.toISOString(),
      successRate: parseFloat(successRate.toFixed(2)),
      plannedClicks: this._results.totalTests
    };
    
    fs.writeFileSync(resultsFile, JSON.stringify(resultsForJson, null, 2), 'utf8');
    console.log(`Результаты сохранены в ${resultsFile}`);
  }
}

async function main(): Promise<void> {
  const testUrl = "https://widget-ctr.vercel.app";
  
  const tester = new WidgetTester(testUrl, 10);
  await tester.runTests();
}

main().catch(console.error); 