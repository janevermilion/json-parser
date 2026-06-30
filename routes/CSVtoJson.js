const express = require('express');
const multer = require('multer');
const csv = require('csvtojson');
const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});

// Функция для парсинга CSV строки с учетом кавычек
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (insideQuotes) {
            if (char === '"' && (i + 1 < line.length && line[i + 1] === '"')) {
                current += '"';
                i++;
            } else if (char === '"') {
                insideQuotes = false;
            } else {
                current += char;
            }
        } else {
            if (char === ',') {
                result.push(current.trim());
                current = '';
            } else if (char === '"') {
                insideQuotes = true;
            } else {
                current += char;
            }
        }
    }
    result.push(current.trim());
    return result;
}

router.post('/', upload.fields([
    { name: 'csvFile', maxCount: 1 },
    { name: 'jsonFile', maxCount: 1 }
]), async function(req, res, next) {
    try {
        if (!req.files || !req.files.csvFile || !req.files.jsonFile) {
            return res.status(400).json({
                error: 'Файлы не загружены',
                message: 'Пожалуйста, загрузите оба файла: CSV и JSON'
            });
        }

        const csvFile = req.files.csvFile[0];
        const jsonFile = req.files.jsonFile[0];

        console.log('📁 Получен CSV файл:', csvFile.originalname);
        console.log('📁 Получен JSON файл:', jsonFile.originalname);

        // 1. Читаем CSV
        const csvString = csvFile.buffer.toString('utf-8');

        // Проверяем на дублирующиеся заголовки
        const lines = csvString.split('\n');
        if (lines.length < 2) {
            return res.status(400).json({
                error: 'Пустой CSV',
                message: 'CSV файл не содержит данных'
            });
        }

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

        // Проверяем наличие дубликатов
        const headerCount = {};
        headers.forEach(h => {
            headerCount[h] = (headerCount[h] || 0) + 1;
        });

        const hasDuplicates = Object.values(headerCount).some(count => count > 1);

        let csvData;

        if (hasDuplicates) {
            console.log('⚠️ Обнаружены дублирующиеся заголовки, создаем уникальные имена');

            // Создаем уникальные заголовки
            const uniqueHeaders = [];
            const countMap = {};
            headers.forEach(h => {
                if (!countMap[h]) {
                    countMap[h] = 1;
                    uniqueHeaders.push(h);
                } else {
                    countMap[h]++;
                    uniqueHeaders.push(`${h}_${countMap[h]}`);
                }
            });

            console.log('📊 Уникальные заголовки:', uniqueHeaders);

            // Парсим данные с уникальными заголовками
            csvData = [];
            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;

                const values = parseCSVLine(lines[i]);
                const row = {};
                uniqueHeaders.forEach((header, index) => {
                    row[header] = values[index] || '';
                });
                csvData.push(row);
            }
        } else {
            // Если дубликатов нет - используем стандартный парсинг
            csvData = await csv().fromString(csvString);
        }

        console.log('✅ CSV сконвертирован, записей:', csvData.length);

        if (csvData.length === 0) {
            return res.status(400).json({
                error: 'Пустой CSV',
                message: 'CSV файл не содержит данных'
            });
        }

        console.log('📊 Заголовки CSV:', Object.keys(csvData[0]));

        // 2. Читаем JSON структуру
        const jsonString = jsonFile.buffer.toString('utf-8');
        let jsonStructure;
        try {
            jsonStructure = JSON.parse(jsonString);
            console.log('✅ JSON структура загружена');
        } catch (parseError) {
            console.error('❌ Ошибка парсинга JSON:', parseError);
            return res.status(400).json({
                error: 'Неверный формат JSON',
                message: 'Загруженный JSON файл не является корректным JSON'
            });
        }

        // 3. Создаем карту соответствий из CSV: id -> XML строка
        const csvMap = {};

        csvData.forEach((row, index) => {
            // Ищем id (может быть в разных полях)
            const csvId = row['id']?.trim() || row['Id']?.trim() || row['ID']?.trim();

            if (csvId && csvId !== 'N/A' && csvId !== '') {
                console.log(`\n📌 Обработка строки ${index + 1}, id: ${csvId}`);

                // Формируем XML строку для Params
                let paramsString = `<element id="${csvId}"`;

                // Добавляем все атрибуты из CSV
                const skipKeys = ['id', 'Id', 'ID'];
                let hasAttributes = false;

                Object.keys(row).forEach(key => {
                    const value = row[key]?.trim();
                    if (value && value !== '' && value !== 'N/A' && !skipKeys.includes(key)) {
                        // Проверяем, что это не submodels
                        if (key !== 'submodels' && key !== 'submodel') {
                            // Добавляем атрибут (всегда в кавычках)
                            paramsString += ` ${key}="${value}"`;
                            hasAttributes = true;
                            console.log(`  📊 Атрибут ${key}: "${value}"`);
                        }
                    }
                });

                // Добавляем submodels если есть
                if (row.submodels && row.submodels.trim() !== '') {
                    paramsString += `>${row.submodels}</element>`;
                } else {
                    paramsString += ` />`;
                }

                csvMap[csvId] = paramsString;
                console.log(`  ✅ Итоговый Params: ${paramsString.substring(0, 200)}...`);
            }
        });

        console.log(`\n📊 Создана карта соответствий для ${Object.keys(csvMap).length} элементов`);

        // 4. Функция для глубокого поиска поля ModelsWithVariables
        function findModelsWithVariables(obj) {
            if (!obj || typeof obj !== 'object') return null;

            if (obj.ModelsWithVariables !== undefined) {
                return { parent: obj, key: 'ModelsWithVariables' };
            }

            for (let key in obj) {
                if (typeof obj[key] === 'object' && obj[key] !== null) {
                    const result = findModelsWithVariables(obj[key]);
                    if (result) return result;
                }
            }
            return null;
        }

        // 5. Находим ModelsWithVariables в структуре
        const found = findModelsWithVariables(jsonStructure);

        if (!found) {
            return res.status(400).json({
                error: 'Неверная структура JSON',
                message: 'В JSON файле не найдено поле ModelsWithVariables'
            });
        }

        let modelsArray = found.parent[found.key];
        console.log(`\n📊 Найдено ModelsWithVariables, элементов: ${modelsArray.length}`);

        // 6. Обновляем Params у каждого элемента
        let updatedCount = 0;
        modelsArray.forEach((model, index) => {
            // Ищем id в текущем Params
            let currentId = null;
            if (model.Params && typeof model.Params === 'string') {
                const idMatch = model.Params.match(/<element\s+id="([^"]+)"/);
                if (idMatch) {
                    currentId = idMatch[1];
                }
            }

            console.log(`\n🔄 Элемент ${index + 1}:`);
            console.log(`  Name: ${model.Name || model.DisplayName || 'без имени'}`);
            console.log(`  Current ID: ${currentId}`);

            if (currentId && csvMap[currentId]) {
                const newParams = csvMap[currentId];
                console.log(`  ✅ Найдены данные в CSV для id: ${currentId}`);
                model.Params = newParams;
                updatedCount++;
            } else {
                console.log(`  ⚠️ Нет данных в CSV для id: ${currentId}`);
            }
        });

        console.log(`\n✅ Обновлено ${updatedCount} из ${modelsArray.length} элементов`);

        // 7. Отправляем результат
        const outputFileName = csvFile.originalname.replace(/\.csv$/i, '_merged.json');
        const resultJson = JSON.stringify(jsonStructure, null, 2);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
        res.setHeader('Content-Length', Buffer.byteLength(resultJson, 'utf-8'));
        res.send(resultJson);

    } catch (err) {
        console.error('❌ Ошибка конвертации:', err);
        res.status(500).json({
            error: 'Ошибка конвертации',
            message: err.message || 'Произошла ошибка при конвертации файлов'
        });
    }
});

module.exports = router;