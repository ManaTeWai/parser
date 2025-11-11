// parser-tr2.js
import puppeteer from "puppeteer";
import fs from "fs/promises";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Основной URL для tr=2
const START_URLS_TR2 = ["https://rasp.bukep.ru/Default.aspx?idFil=10006&tr=2"];

const NAV_TIMEOUT = 60_000; // ms
const OUTPUT_FILE_TR2 = "parsed_data_tr2.json";

// Модифицированная функция для парсинга таблицы расписания для tr=2
async function parseScheduleTableTR2(page) {
	try {
		console.log("  -> Начинаю парсинг таблицы расписания (tr=2) на странице:", page.url());
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

					// Для tr=2 нет кнопки преподавателя, поэтому убираем её
					// const teacherButton = row.querySelector("input.fioprep");

					if (numParaCell && paraCell) {
						// Извлекаем время/номер пары из td.num_para
						const rawLessonTimeHtml = numParaCell.innerHTML || "";
						const lessonTime = rawLessonTimeHtml.replace(/<br\s*\/?>(\s*)/gi, "<br>").trim();

						// Первый span содержит основную строку с <br>, второй span часто содержит номер аудитории
						const spans = paraCell.querySelectorAll("span");
						const lessonInfo = spans && spans.length > 0 ? spans[0] : null;
						// Сохраняем HTML-контент с <br> тегами из первого span
						const lessonHtml = lessonInfo ? lessonInfo.innerHTML || "" : "";
						// Попробуем получить комнату из второго span (если есть)
						const roomSpan = spans && spans.length > 1 ? spans[1] : null;
						const roomFromSpan = roomSpan ? (roomSpan.innerText || roomSpan.textContent || "").trim() : "";

						let subject = "";
						let lessonType = "";
						let room = "";
						let groups = []; // Новое поле для групп

						// Разделяем HTML-контент по тегам <br>
						const lines = lessonHtml
							.split(/<br\s*\/?\>/gi) // Разбиваем по <br> и <br/>
							.map((line) => line.trim())
							.filter((line) => line);

						if (lines.length >= 2) {
							// subject - первая строка
							const tempDiv = document.createElement("div");
							tempDiv.innerHTML = lines[0];
							subject = tempDiv.innerText || tempDiv.textContent || "";

							// Получаем все остальные строки после первой и объединяем их обратно в строку
							const afterFirstLineHtml = lines.slice(1).join(" ").trim();
							// Создаем временный div для получения чистого текста из оставшегося HTML
							const tempDiv2 = document.createElement("div");
							tempDiv2.innerHTML = afterFirstLineHtml;
							const afterFirstLineText = tempDiv2.innerText || tempDiv2.textContent || "";

							// Ищем группы: ищем шаблоны вроде "ЮР-С221оз, ЮР-С222оз" или "ЮР-С221оз"
							const groupRegex = /([А-Яа-яЁёA-Za-z]+\s*-\s*[А-Яа-яЁёA-Za-z0-9]+)/g;
							const foundGroups = afterFirstLineText.match(groupRegex) || [];
							groups = [...new Set(foundGroups)].map((g) => g.trim());

							// Оставшуюся часть строки (без групп) обрабатываем как раньше для lessonType и room
							let remainingText = afterFirstLineText;
							foundGroups.forEach((group) => {
								const escapedGroup = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
								remainingText = remainingText.replace(new RegExp("\\s*,?\\s*" + escapedGroup + "\\s*,?", "gi"), " ").trim();
							});

							// Проверяем на специальный случай 'ДСП "Спартак"'
							if (remainingText.includes('ДСП "Спартак"')) {
								const spartakIndex = remainingText.indexOf('ДСП "Спартак"');
								lessonType = remainingText.substring(0, spartakIndex).replace(/\s+/g, " ").trim();
								room = 'ДСП "Спартак"';
							} else {
								// Ищем последовательность цифр (1-3) в конце строки для room
								const roomMatch = remainingText.match(/^(.+)\s+(\d{1,3})$/);
								if (roomMatch) {
									lessonType = roomMatch[1].trim();
									room = roomMatch[2].trim();
								} else {
									// Если нет числа в конце, то оставшийся текст - это lessonType
									lessonType = remainingText;
									room = "";
								}
							}

							// Если был второй span с комнатой — используем его как приоритет (если он не пустой)
							if (roomFromSpan) {
								room = roomFromSpan;
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
							lessonTime: lessonTime,
							subject: subject,
							lessonType: lessonType,
							room: room,
							groups: groups, // Используем новое поле
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

		console.log("  <- Парсинг таблицы расписания (tr=2) завершен.");
		return {
			hasSchedule: true,
			message: "Расписание найдено",
			lessons: scheduleData,
		};
	} catch (error) {
		console.warn("Ошибка при парсинге расписания (tr=2):", error);
		return {
			hasSchedule: false,
			message: "Ошибка парсинга",
			lessons: [],
		};
	}
}

// Используем общую функцию глубокого парсинга, но с новой функцией парсинга таблицы
async function deepParsePage(page, startUrl, currentLevel = 1, maxLevel = 4, parseScheduleFn = parseScheduleTableTR2) {
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
				console.warn(
					`     ВНИМАНИЕ: Ожидание навигации для "${
						link.text
					}" завершено по таймауту (${NAV_TIMEOUT}ms) или произошла ошибка. Текущий URL: ${page.url()}`
				);
				// Попытка подстраховки: если навигация не сработала, попробуем дождаться таблицы расписания или контента
				try {
					await page.waitForSelector("table.tbl_day", { timeout: 5000 });
					console.log("     Таблица расписания появилась после таймаута навигации.");
				} catch (e) {
					console.log("     Таблица расписания не обнаружена после таймаута навигации.");
				}
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

			// Если на странице есть таблица расписания или лейбл "Расписание отсутствует", парсим расписание
			// (Не полагаемся на конкретный уровень, т.к. структура страниц может отличаться)
			try {
				const hasTable = (await page.$("table.tbl_day")) !== null;
				const hasLabel = (await page.$("#ctl00_head_Label1")) !== null;
				if (hasTable || hasLabel) {
					console.log(`     -> Парсинг расписания (обнаружен table.tbl_day или label) для: ${link.text}`);
					const scheduleData = await parseScheduleFn(page);
					result.schedule = scheduleData;
					console.log(`     <- Расписание: ${scheduleData.message}, найдено занятий: ${scheduleData.lessons.length}`);
				}
			} catch (e) {
				console.warn("     Не удалось проверить наличие расписания на странице:", e && e.message ? e.message : e);
			}

			results.push(result);

			// Если это не максимальный уровень и мы парсим tr2, продолжаем парсинг
			const isTr2 = startUrl.includes("tr=2");
			if (currentLevel < maxLevel && isTr2) {
				console.log(`     -> Рекурсивный вызов для уровня ${currentLevel + 1} для: ${link.text}`);
				// Передаем ту же функцию парсинга в рекурсивный вызов
				const deepResults = await deepParsePage(page, page.url(), currentLevel + 1, maxLevel, parseScheduleFn);
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

export async function GET_TR2() {
	let browser;
	try {
		console.log("Запускаю браузер...");
		browser = await puppeteer.launch({
			headless: false, // Используйте true для headless режима
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
		const tr2Results = [];

		for (const startUrl of START_URLS_TR2) {
			console.log(`\n=== НАЧИНАЮ ОБРАБОТКУ URL: ${startUrl} ===`);
			await page.goto(startUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });

			if (startUrl.includes("tr=2")) {
				console.log("Парсинг tr2 с глубоким проходом...");
				// Передаем новую функцию парсинга таблицы
				const results = await deepParsePage(page, startUrl, 0, 4, parseScheduleTableTR2);
				tr2Results.push(...results);
			}
			console.log(`=== ЗАВЕРШЕНА ОБРАБОТКА URL: ${startUrl} ===`);
		}

		await browser.close();
		console.log("Браузер закрыт.");
		return {
			ok: true,
			tr2Results,
			totalResults: tr2Results.length,
		};
	} catch (error) {
		if (browser) await browser.close().catch(() => {});
		console.error("Критическая ошибка в GET_TR2:", error);
		return { ok: false, error: error.message || String(error) };
	}
}

// Функция для записи данных в JSON файл
async function saveToJSON(data, filename = OUTPUT_FILE_TR2) {
	// Используем OUTPUT_FILE_TR2 как значение по умолчанию
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

// Основная функция для запуска парсера tr2
async function main() {
	console.log("Запуск парсера для tr=2...");

	try {
		const result = await GET_TR2();

		if (result.ok) {
			console.log(`Получено ${result.totalResults} результатов`);
			console.log(`- tr2: ${result.tr2Results.length} результатов`);

			// Сохраняем результаты tr2 в отдельный JSON файл
			if (result.tr2Results.length > 0) {
				const saveTr2Success = await saveToJSON(result.tr2Results, OUTPUT_FILE_TR2);
				if (saveTr2Success) {
					console.log(`Результаты tr2 сохранены в файл: ${OUTPUT_FILE_TR2}`);
				} else {
					console.error("Ошибка при сохранении результатов tr2");
				}
			}

			console.log("\nПарсинг tr=2 завершен успешно!");

			// Выводим краткую статистику для tr2
			if (result.tr2Results.length > 0) {
				console.log("\nСтатистика tr2 (с уровнями):");
				result.tr2Results.forEach((item, index) => {
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
			console.error("Ошибка парсинга tr=2:", result.error);
		}
	} catch (error) {
		console.error("Критическая ошибка в main для tr=2:", error);
	}
}

// Запускаем парсер, если файл выполняется напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
