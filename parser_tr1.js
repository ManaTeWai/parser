import puppeteer from "puppeteer";
import fs from "fs/promises";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const START_URLS = ["https://rasp.bukep.ru/Default.aspx?idFil=10006&tr=1"];

const NAV_TIMEOUT = 20_000;
const OUTPUT_FILE_TR1 = "parsed_data_tr1.json";

// Функция для парсинга таблицы расписания
async function parseScheduleTable(page) {
	try {
		console.log("  -> Начинаю парсинг таблицы расписания на странице:", page.url());
		// Проверяем, есть ли лейбл "Расписание отсутствует"
		const noScheduleLabel = await page.$eval("#ctl00_head_Label1", (el) => el.textContent?.trim()).catch(() => null);

		if (noScheduleLabel && noScheduleLabel.includes("Расписание отсутствует")) {
			console.log("  <- Расписание отсутствует на странице:", page.url());
			return {
				hasSchedule: false,
				message: "Расписание отсутствует",
				lessons: [],
			};
		}

		// Парсим таблицы расписания
		const scheduleData = await page.$$eval("table.tbl_day", (tables) => {
			console.log(`  -> Найдено ${tables.length} таблиц(ы) расписания.`);
			const allLessons = [];

			// Функция для очистки lessonType: оставляем только буквы (рус/лат) и пробелы
			const sanitizeLessonType = (s) => {
				if (!s) return "";
				// Удаляем всё, что не буквы и не пробелы (включая цифры и знаки припинания), затем сжимаем пробелы
				return s
					.replace(/[^A-Za-zА-Яа-яЁё\s]+/g, " ")
					.replace(/\s+/g, " ")
					.trim();
			};

			tables.forEach((table, tableIndex) => {
				console.log(`  -> Обрабатываю таблицу ${tableIndex + 1}`);
				const rows = table.querySelectorAll("tr");
				let currentDay = "";

				rows.forEach((row, rowIndex) => {
					// Проверяем, является ли строка заголовком дня
					if (row.classList && row.classList.contains("day")) {
						const firstCell = row.querySelector("td");
						currentDay = (firstCell?.textContent || "").trim();
						console.log(`     Найден день: "${currentDay}"`);
						return;
					}

					// Парсим строки с занятиями
					const numParaCell = row.querySelector("td.num_para");
					const paraCell = row.querySelector("td.para");
					const teacherButton = row.querySelector("input.fioprep, input.fioprep_hight");

					if (numParaCell && paraCell) {
						// Извлекаем содержимое td.num_para
						const rawLessonTimeHtml = numParaCell.innerHTML || "";
						const numParaText = numParaCell.textContent || "";

						// Определяем тип недели на основе содержимого num_para
						let week = "both";
						if (numParaText.includes("Числ.")) {
							week = "num";
						} else if (numParaText.includes("Знам.")) {
							week = "den";
						}

						// Извлекаем только номер пары (цифры в начале строки)
						// Например, из "1<br>Знам." -> "1", из "4<br>14:35" -> "4"
						const lessonTimeMatch = rawLessonTimeHtml.match(/^(\d+)<br>/i);
						const lessonTime = lessonTimeMatch ? lessonTimeMatch[1] : "";

						const lessonInfo = paraCell.querySelector("span");
						// Сохраняем HTML-контент с <br> тегами
						const lessonHtml = lessonInfo ? lessonInfo.innerHTML || "" : "";
						const teacher = teacherButton ? teacherButton.value?.trim() : "";

						// Парсим информацию о занятии согласно требованиям
						let subject = "";
						let lessonType = "";
						let room = "";

						// Разделяем HTML-контент по тегам <br>
						const lines = lessonHtml
							.split(/<br\s*\/?\>/gi) // Разбиваем по <br> и <br/>
							.map((line) => line.trim())
							.filter((line) => line);

						if (lines.length >= 2) {
							// subject - первая строка (декодируем HTML entities, если нужно, но innerText уже делает это)
							// Используем innerText для получения чистого текста из строки HTML
							const tempDiv = document.createElement("div");
							tempDiv.innerHTML = lines[0];
							subject = tempDiv.innerText || tempDiv.textContent || "";

							// Получаем все остальные строки после первой и объединяем их обратно в строку
							const afterFirstLineHtml = lines.slice(1).join(" ").trim();
							// Создаем временный div для получения чистого текста из оставшегося HTML
							const tempDiv2 = document.createElement("div");
							tempDiv2.innerHTML = afterFirstLineHtml;
							const afterFirstLineText = tempDiv2.innerText || tempDiv2.textContent || "";

							// Проверяем, есть ли "ДСП \"Спартак\"" в тексте
							if (afterFirstLineText.includes('ДСП "Спартак"')) {
								// Тип занятия - всё, что до "ДСП \"Спартак\""
								const spartakIndex = afterFirstLineText.indexOf('ДСП "Спартак"');
								lessonType = afterFirstLineText.substring(0, spartakIndex).replace(/\s+/g, " ").trim();
								// Кабинет - "ДСП \"Спартак\""
								room = 'ДСП "Спартак"';
							} else {
								// Ищем последовательность цифр (1-3) в конце строки для room
								// Используем регулярное выражение для поиска числа в конце строки
								// (.+) - захватывает весь текст до последнего числа
								// \s+ - пробелы между текстом и числом
								// (\d{1,3})$ - число из 1-3 цифр в конце строки
								const roomMatch = afterFirstLineText.match(/^(.+)\s+(\d{1,3})$/);

								if (roomMatch) {
									lessonType = roomMatch[1].trim();
									room = roomMatch[2].trim();
								} else {
									// Если нет числа в конце, то весь текст после первой строки - это lessonType, room пустой
									lessonType = afterFirstLineText;
									room = "";
								}
							}

							// Очищаем lessonType: оставляем только буквы и пробелы
							lessonType = sanitizeLessonType(lessonType);
						} else if (lines.length === 1) {
							// Если только одна строка, то весь текст - это subject
							const tempDiv = document.createElement("div");
							tempDiv.innerHTML = lines[0];
							subject = tempDiv.innerText || tempDiv.textContent || "";
						}

						allLessons.push({
							day: currentDay,
							week: week, // Добавлено поле week
							lessonTime: lessonTime, // Теперь содержит только номер пары
							subject: subject,
							lessonType: lessonType,
							room: room,
							teacher: teacher,
						});
					} else {
						// Добавлено: логирование, если строка не содержит num_para и para
						console.log(`     Строка ${rowIndex} не содержит td.num_para или td.para, пропускаю.`);
					}
				});
			});

			console.log(`  <- Найдено ${allLessons.length} занятий.`);
			return allLessons;
		});

		console.log("  <- Парсинг таблицы расписания завершен.");
		return {
			hasSchedule: true,
			message: "Расписание найдено",
			lessons: scheduleData,
		};
	} catch (error) {
		console.warn("Ошибка при парсинге расписания:", error);
		return {
			hasSchedule: false,
			message: "Ошибка парсинга",
			lessons: [],
		};
	}
}

// Функция для глубокого парсинга страниц (рекурсивный проход по уровням)
async function deepParsePage(page, startUrl, currentLevel = 1, maxLevel = 5) {
	console.log(`\n--- Начинаю глубокий парсинг уровня ${currentLevel} для URL: ${startUrl} ---`);
	const results = [];

	// Получаем все ссылки с __doPostBack
	const postbackLinks = await page.$$eval("a[href^='javascript:__doPostBack(']", (nodes) =>
		nodes.map((a) => ({
			id: a.getAttribute("id") || "",
			text: a.textContent?.trim() || "",
			href: a.getAttribute("href") || "",
		}))
	);

	console.log(`  -> Найдено ${postbackLinks.length} ссылок для клика на уровне ${currentLevel}.`);

	for (const [index, link] of postbackLinks.entries()) {
		console.log(`\n  Обрабатываю ссылку ${index + 1}/${postbackLinks.length}: "${link.text}" (ID: ${link.id})`);

		if (!link.id) {
			console.warn(`     Пропускаю ссылку "${link.text}" - отсутствует ID.`);
			continue; // <-- Это место, где могут пропускаться элементы
		}

		try {
			// Экранируем ID для корректного CSS селектора.
			// Сначала пробуем воспользоваться CSS.escape в контексте страницы (корректно обрабатывает пробелы и non-ASCII).
			let escapedId;
			try {
				escapedId = await page.evaluate((id) => {
					if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(id);
					// fallback: экранируем отдельные специальные символы и пробел
					return id.replace(/([!"#$%&'()*+,./:;<=>?@[\\\\\]^`{|}~\s])/g, "\\$1");
				}, link.id);
			} catch (e) {
				// На случай, если page.evaluate упадёт — используем локальный fallback
				escapedId = link.id.replace(/([!"#$%&'()*+,./:;<=>?@[\\\\\]^`{|}~\s])/g, "\\$1");
			}

			console.log(`     Ищу элемент с ID: #${escapedId}`);
			// Используем let, т.к. может понадобиться переназначение после перезагрузки страницы
			let elHandle = await page.$(`#${escapedId}`);
			if (!elHandle) {
				console.warn(`     Элемент с ID #${escapedId} не найден. Пытаюсь перезагрузить страницу.`);
				await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
				console.log(`     Страница перезагружена. Повторно ищу элемент с ID: #${escapedId}`);
				elHandle = await page.$(`#${escapedId}`);
				if (!elHandle) {
					console.warn(`     Пропускаю ссылку "${link.text}" - элемент с ID #${escapedId} не найден после перезагрузки.`);
					continue; // <-- Теперь пропускаем только после перезагрузки
				} else {
					console.log(`     Элемент найден после перезагрузки.`);
				}
			}

			console.log(`     Элемент найден. Начинаю клик.`);

			const navigationPromise = page.waitForNavigation({ waitUntil: "networkidle0", timeout: NAV_TIMEOUT }).catch(() => null);
			await elHandle.click();
			console.log(`     Клик выполнен. Ожидаю навигацию...`);
			const navResult = await navigationPromise;
			if (!navResult) {
				console.warn(`     ВНИМАНИЕ: Ожидание навигации для "${link.text}" завершено по таймауту (${NAV_TIMEOUT}ms) или произошла ошибка. Текущий URL: ${page.url()}`);
			} else {
				console.log(`     Навигация успешна. Новый URL: ${page.url()}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 500)); // Ждем 500мс после навигации

			const result = {
				from: startUrl,
				level: currentLevel,
				clickedText: link.text,
				landedUrl: page.url(),
			};

			// Если это уровень 3 (группы), парсим расписание
			if (currentLevel === 3) {
				console.log(`     -> Парсинг расписания для группы: ${link.text}`);
				const scheduleData = await parseScheduleTable(page);
				result.schedule = scheduleData;
				console.log(`     <- Расписание: ${scheduleData.message}, найдено занятий: ${scheduleData.lessons.length}`);
			}

			results.push(result);

			// Если это не максимальный уровень и мы парсим tr1, продолжаем парсинг
			const isTr1 = startUrl.includes("tr=1") || startUrl.includes("tr=s") || startUrl.includes("tr=k");
			if (currentLevel < maxLevel && isTr1) {
				console.log(`     -> Рекурсивный вызов для уровня ${currentLevel + 1} для: ${link.text}`);
				const deepResults = await deepParsePage(page, page.url(), currentLevel + 1, maxLevel);
				results.push(...deepResults);
				console.log(`     <- Рекурсивный вызов для уровня ${currentLevel + 1} завершен.`);
			}

			// Возвращаемся назад
			console.log(`     Пытаюсь вернуться назад...`);
			try {
				const goBackPromise = page.goBack({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => null);
				await goBackPromise;
				console.log(`     Успешно вернулся назад. Текущий URL: ${page.url()}`);
				// Ждем, пока элемент снова станет доступен
				await page.waitForSelector(`#${escapedId}`, { timeout: 5000 }).catch(() => {});
				console.log(`     Элемент #${escapedId} снова доступен.`);
			} catch (backErr) {
				console.warn(`     Ошибка при возврате назад для "${link.text}":`, backErr.message || backErr);
				console.log(`     Пытаюсь вернуться к начальному URL: ${startUrl}`);
				await page.goto(startUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => {});
				console.log(`     Возврат к начальному URL завершен. Текущий URL: ${page.url()}`);
			}
		} catch (err) {
			console.warn("     Ошибка при обработке ссылки", link.text, ":", err.message || err);
			console.log(`     Пытаюсь восстановить состояние, возвращаясь к начальному URL: ${startUrl}`);
			await page.goto(startUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => {});
			console.log(`     Восстановление завершено. Текущий URL: ${page.url()}`);
		}
	}

	console.log(`--- Глубокий парсинг уровня ${currentLevel} завершен. Найдено ${results.length} результатов. ---\n`);
	return results;
}

export async function GET() {
	let browser;
	try {
		console.log("Запускаю браузер...");
		browser = await puppeteer.launch({
			headless: true, // Используйте true для headless режима
			executablePath: '/usr/bin/chromium-browser', // Путь к вашему Chromium/Chrome
			ignoreHTTPSErrors: true, // Включаем игнор в puppeteer
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--ignore-certificate-errors", // игнорируем ошибки сертификатов
				"--allow-insecure-localhost", // разрешаем недоверенные сертификаты на localhost (на случай разработки)
			],
		});

		const page = await browser.newPage();
		// на будущее: можно настроить userAgent, viewport и т.д.
		const tr1Results = [];

		for (const startUrl of START_URLS) {
			console.log(`\n=== НАЧИНАЮ ОБРАБОТКУ URL: ${startUrl} ===`);
			await page.goto(startUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });

			if (startUrl.includes("tr=1")) {
				console.log("Парсинг tr1 с глубоким проходом...");
				const results = await deepParsePage(page, startUrl, 0, 4);
				tr1Results.push(...results);
			}
			console.log(`=== ЗАВЕРШЕНА ОБРАБОТКА URL: ${startUrl} ===`);
		}

		await browser.close();
		console.log("Браузер закрыт.");
		return {
			ok: true,
			tr1Results,
			totalResults: tr1Results.length,
		};
	} catch (error) {
		if (browser) await browser.close().catch(() => {});
		console.error("Критическая ошибка в GET:", error);
		return { ok: false, error: error.message || String(error) };
	}
}

// Поддержка аргумента --out
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1 && process.argv[outIndex + 1]) {
	OUTPUT_FILE_TR1 = process.argv[outIndex + 1];
}

// Функция для записи данных в JSON файл
async function saveToJSON(data, filename = OUTPUT_FILE_TR1) {
	// Используем OUTPUT_FILE_TR1 как значение по умолчанию
	try {
		const jsonData = JSON.stringify(data, null, 2);
		await fs.writeFile(filename, jsonData, "utf8");
		console.log(`Данные успешно сохранены в файл: ${filename}`);
		return true;
	} catch (error) {
		console.error("Ошибка при сохранении в JSON файл:", error);
		return false;
	}
}

// Основная функция для запуска парсера
async function main() {
	console.log("Запуск парсера...");

	try {
		const result = await GET();

		if (result.ok) {
			console.log(`Получено ${result.totalResults} результатов`);
			console.log(`- tr1: ${result.tr1Results.length} результатов`);

			// Сохраняем результаты tr1 в отдельный JSON файл
			if (result.tr1Results.length > 0) {
				const saveTr1Success = await saveToJSON(result.tr1Results, OUTPUT_FILE_TR1);
				if (saveTr1Success) {
					console.log(`Результаты tr1 сохранены в файл: ${OUTPUT_FILE_TR1}`);
				} else {
					console.error("Ошибка при сохранении результатов tr1");
				}
			}

			console.log("\nПарсинг завершен успешно!");

			// Выводим краткую статистику для tr1
			if (result.tr1Results.length > 0) {
				console.log("\nСтатистика tr1 (с уровнями):");
				result.tr1Results.forEach((item, index) => {
					console.log(`${index + 1}. [Уровень ${item.level}] ${item.clickedText} -> ${item.landedUrl}`);
					if (item.schedule && item.schedule.hasSchedule) {
						console.log(`   Найдено занятий: ${item.schedule.lessons.length}`);
						// Выводим пример одного занятия
						if (item.schedule.lessons.length > 0) {
							console.log(`   Пример занятия: ${JSON.stringify(item.schedule.lessons[0], null, 2)}`);
						}
					}
				});
			}
		} else {
			console.error("Ошибка парсинга:", result.error);
		}
	} catch (error) {
		console.error("Критическая ошибка в main:", error);
	}
}

// Запускаем парсер, если файл выполняется напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
