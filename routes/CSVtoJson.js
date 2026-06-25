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
        console.log('📄 Первые 500 символов CSV:');
        console.log(csvString.substring(0, 500));

        const csvData = await csv().fromString(csvString);
        console.log('✅ CSV сконвертирован, записей:', csvData.length);

        if (csvData.length === 0) {
            return res.status(400).json({
                error: 'Пустой CSV',
                message: 'CSV файл не содержит данных'
            });
        }

        // Выводим первую строку для проверки
        console.log('📊 Первая строка CSV:', JSON.stringify(csvData[0], null, 2));
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

        // 3. Создаем карту соответствий из CSV: id -> Params
        const csvMap = {};
        csvData.forEach((row, index) => {
            // Ищем id
            const csvId = row['id']?.trim() || row['Id']?.trim() || row['ID']?.trim();

            if (csvId && csvId !== 'N/A' && csvId !== '') {
                console.log(`\n📌 Обработка строки ${index + 1}, id: ${csvId}`);

                // Явно берем name из CSV
                const elementName = row['name']?.trim() || row['Name']?.trim();
                console.log(`  name из CSV: "${elementName}"`);

                // Берем type
                const elementType = row['type']?.trim() || row['Type']?.trim() || 'saturn-devices[valve]';
                console.log(`  type из CSV: "${elementType}"`);

                // Собираем остальные атрибуты (исключаем служебные)
                const skipKeys = [
                    'id', 'Id', 'ID',
                    'name', 'Name',
                    'type', 'Type',
                    'submodels', 'submodel',
                    'updated_params', 'updated-params',
                    'Model_Index', 'Original_Name', 'Original_Id', 'Original_Path',
                    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
                ];

                // Формируем строку Params
                let paramsString = `<element id="${csvId}"`;

                // Добавляем name (обязательно из CSV)
                if (elementName && elementName !== '') {
                    paramsString += ` name="${elementName}"`;
                } else {
                    // Если name отсутствует, используем id
                    paramsString += ` name="${csvId}"`;
                }

                // Добавляем type
                if (elementType && elementType !== '') {
                    paramsString += ` type="${elementType}"`;
                }

                // Добавляем все остальные атрибуты (кроме name и type)
                Object.keys(row).forEach(key => {
                    const value = row[key]?.trim();
                    // Пропускаем если пусто или служебное
                    if (value && value !== '' && value !== 'N/A' && !skipKeys.includes(key)) {
                        // Пропускаем если это submodel или содержит теги
                        if (!value.includes('<submodel') && !value.includes('<')) {
                            // Проверяем, нужно ли заключать в кавычки
                            if (isNaN(value) && value !== 'true' && value !== 'false') {
                                paramsString += ` ${key}="${value}"`;
                            } else {
                                paramsString += ` ${key}=${value}`;
                            }
                            console.log(`  📊 Добавлен атрибут ${key}: "${value}"`);
                        }
                    }
                });

                // Добавляем submodels если есть
                const submodelParts = [];
                Object.keys(row).forEach(key => {
                    const value = row[key]?.trim();
                    if (value && value !== '' && value !== 'N/A' && value.includes('<submodel')) {
                        let cleanValue = value.replace(/\s+/g, ' ').trim();
                        submodelParts.push(cleanValue);
                    }
                });

                let submodelsString = submodelParts.join('');
                submodelsString = submodelsString.replace(/\/>\s+</g, '/><');
                submodelsString = submodelsString.replace(/>\s+</g, '><');
                submodelsString = submodelsString.replace(/\s+/g, ' ').trim();

                if (submodelsString) {
                    paramsString += `>${submodelsString}</element>`;
                } else {
                    paramsString += ` />`;
                }

                csvMap[csvId] = paramsString;
                console.log(`  ✅ Итоговый Params: ${paramsString}`);
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
            // Ищем id в Params
            let currentId = null;
            if (model.Params) {
                const idMatch = model.Params.match(/<element\s+id="([^"]+)"/);
                if (idMatch) {
                    currentId = idMatch[1];
                }
            }

            console.log(`\n🔄 Элемент ${index + 1}:`);
            console.log(`  Name: ${model.Name}`);
            console.log(`  Current ID: ${currentId}`);

            if (currentId && csvMap[currentId]) {
                const newParams = csvMap[currentId];
                console.log(`  ✅ Найдены данные в CSV для id: ${currentId}`);
                console.log(`  📊 Новый Params: ${newParams}`);
                model.Params = newParams;
                updatedCount++;
            } else {
                console.log(`  ⚠️ Нет данных в CSV для id: ${currentId}`);
            }
        });

        console.log(`\n✅ Обновлено ${updatedCount} элементов`);

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